package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

//go:embed index.html
var adminHTML []byte

//go:embed admin.js
var adminJS []byte

type app struct {
	store       *storage
	client      *whatsmeow.Client
	mu          sync.RWMutex
	ready       bool
	pairing     bool
	qr          string
	qrExpiry    time.Time
	pairState   string
	pairError   string
	adminSecret string
	relaySecret string
	origin      string
	wake        chan struct{}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	admin, relay, origin := os.Getenv("ADMIN_TOKEN"), os.Getenv("RELAY_SECRET"), os.Getenv("PUBLIC_ORIGIN")
	u, err := url.Parse(origin)
	if !hex64.MatchString(admin) || !hex64.MatchString(relay) || admin == relay || err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		log.Fatal("private_configuration_required")
	}
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	s, err := openStorage(startup, os.Getenv("DATABASE_URL"))
	cancel()
	if err != nil {
		log.Fatal("database_setup_required")
	}
	defer s.db.Close()
	a := &app{store: s, adminSecret: admin, relaySecret: relay, origin: origin, wake: make(chan struct{}, 1), pairState: "not_linked"}
	go a.run(ctx)
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{Addr: ":" + port, Handler: a.handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 150 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Print("relay_starting")
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print("relay_http_stopped")
	}
}

func (a *app) run(ctx context.Context) {
	// A session advisory lock prevents two cloud deployments from connecting
	// the same WhatsApp device or recovering each other's in-flight attempts.
	conn, err := a.store.db.Conn(ctx)
	if err != nil {
		return
	}
	defer conn.Close()
	var locked bool
	if conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(714826403195)").Scan(&locked) != nil || !locked {
		log.Print("relay_worker_already_active")
		return
	}
	defer conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(714826403195)")
	container, err := a.store.upgrade(ctx)
	if err != nil {
		log.Print("private_schema_setup_required")
		return
	}
	devices, err := container.GetAllDevices(ctx)
	if err != nil || len(devices) > 1 {
		log.Print("single_device_required")
		return
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return
	}
	client := whatsmeow.NewClient(device, nil)
	// No chat-history download: only linked-device protocol state and outbound
	// placement messages are needed for this relay.
	client.ManualHistorySyncDownload = true
	client.InitialAutoReconnect = true
	client.AddEventHandler(func(event any) {
		switch e := event.(type) {
		case *events.LoggedOut:
			a.mu.Lock()
			a.qr = ""
			a.pairState = "relink_required"
			a.mu.Unlock()
		case *events.Connected:
			a.mu.Lock()
			a.qr = ""
			a.pairState = "linked"
			a.pairError = ""
			a.mu.Unlock()
			a.notify()
		case *events.PairError:
			a.recordPairError(pairingErrorCode(e.Error))
		case *events.PairPasskeyRequest:
			a.recordPairError("passkey_required")
		case *events.PairPasskeyError:
			a.recordPairError("passkey_verification_failed")
		case *events.ConnectFailure:
			a.recordPairError("whatsapp_connection_" + strconv.Itoa(int(e.Reason)))
		case *events.ClientOutdated:
			a.recordPairError("client_update_required")
		case *events.StreamError:
			code := "whatsapp_stream_rejected"
			if len(e.Code) == 3 {
				if _, err := strconv.Atoi(e.Code); err == nil {
					code = "whatsapp_stream_" + e.Code
				}
			}
			a.recordPairError(code)
		case *events.Receipt:
			// Record a receipt signal, without collecting incoming chat content.
			if e.Type != types.ReceiptTypeDelivered && e.Type != types.ReceiptTypeRead {
				return
			}
			for _, id := range e.MessageIDs {
				receiptCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				a.store.db.ExecContext(receiptCtx, "UPDATE relay_jobs SET receipt_at=$2,state='acknowledged',acknowledged_at=COALESCE(acknowledged_at,$2) WHERE message_id=$1 AND state IN ('attempting','uncertain','acknowledged')", string(id), e.Timestamp)
				cancel()
			}
		}
	})
	a.mu.Lock()
	a.client = client
	a.ready = true
	if device.ID != nil {
		a.pairState = "connecting"
	}
	a.mu.Unlock()
	if device.ID != nil {
		client.Connect()
	}
	defer client.Disconnect()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-a.wake:
		}
		// If the lock connection is lost, stop the instance rather than send
		// concurrently with a replacement that acquired the database lock.
		probe, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = conn.PingContext(probe)
		cancel()
		if err != nil {
			a.mu.Lock()
			a.ready = false
			a.mu.Unlock()
			client.Disconnect()
			log.Print("relay_lock_lost")
			return
		}
		if !client.IsLoggedIn() || !client.IsConnected() {
			continue
		}
		for i := 0; i < 20; i++ {
			j, err := a.store.nextJob(ctx)
			if err == sql.ErrNoRows {
				break
			}
			if err != nil {
				break
			}
			if !validTarget(j.JID) {
				log.Print("invalid_saved_target")
				break
			}
			id := string(client.GenerateMessageID())
			started, err := a.store.beginAttempt(ctx, j, id)
			if err != nil || !started {
				break
			}
			jid, _ := types.ParseJID(j.JID)
			sendCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
			response, sendErr := client.SendMessage(sendCtx, jid, &waE2E.Message{Conversation: proto.String(j.Message)}, whatsmeow.SendRequestExtra{ID: types.MessageID(id), Timeout: 60 * time.Second})
			cancel()
			ack := sendErr == nil && string(response.ID) == id
			finishCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err = a.store.finishAttempt(finishCtx, j, ack)
			cancel()
			if err != nil || !ack {
				log.Print("whatsapp_send_needs_review")
				break
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func (a *app) notify() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func apiError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": code})
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "Placement WhatsApp relay\n")
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(adminHTML)
	})
	mux.HandleFunc("GET /admin.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Write(adminJS)
	})
	mux.HandleFunc("POST /v1", a.signed)
	mux.Handle("GET /api/status", a.admin(http.HandlerFunc(a.status)))
	mux.Handle("POST /api/link", a.admin(http.HandlerFunc(a.link)))
	mux.Handle("POST /api/phone-link", a.admin(http.HandlerFunc(a.phoneLink)))
	mux.Handle("GET /api/qr", a.admin(http.HandlerFunc(a.qrImage)))
	mux.Handle("GET /api/groups", a.admin(http.HandlerFunc(a.groups)))
	mux.Handle("PUT /api/destinations", a.admin(http.HandlerFunc(a.targets)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		if r.Header.Get("Origin") != "" && r.Header.Get("Origin") != a.origin {
			apiError(w, 403, "origin_rejected")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *app) admin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actual := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		expected := sha256.Sum256([]byte("Bearer " + a.adminSecret))
		if subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			apiError(w, 401, "authentication_required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) state(ctx context.Context) (map[string]any, error) {
	a.mu.RLock()
	client, ready, pairState, pairError := a.client, a.ready, a.pairState, a.pairError
	a.mu.RUnlock()
	counts, err := a.store.counts(ctx)
	if err != nil {
		return nil, err
	}
	targets, err := a.store.destinations(ctx)
	if err != nil {
		return nil, err
	}
	linked := client != nil && client.Store.ID != nil && pairState != "relink_required"
	connected := client != nil && client.IsConnected() && client.IsLoggedIn()
	return map[string]any{"ok": true, "ready": ready, "linked": linked, "connected": connected, "pair_state": pairState, "pair_error": pairError, "destination_count": len(targets), "counts": counts, "needs_attention": !ready || !linked || counts["uncertain"] > 0}, nil
}

func (a *app) signed(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 100000))
	if err != nil {
		apiError(w, 400, "invalid_request")
		return
	}
	e, err := authenticate(raw, a.relaySecret, time.Now())
	if err != nil {
		apiError(w, 401, "authentication_failed")
		return
	}
	if err = a.store.consumeNonce(r.Context(), e.Nonce); err != nil {
		apiError(w, 409, "request_not_accepted")
		return
	}
	if e.Action == "status" {
		if string(e.Payload) != "{}" {
			apiError(w, 400, "invalid_payload")
			return
		}
		value, err := a.state(r.Context())
		if err != nil {
			apiError(w, 503, "database_unavailable")
			return
		}
		writeJSON(w, 200, value)
		return
	}
	var post announcement
	if decodeStrict(e.Payload, &post) != nil || validateAnnouncement(post) != nil {
		apiError(w, 400, "invalid_payload")
		return
	}
	a.mu.RLock()
	ready, client, pairState := a.ready, a.client, a.pairState
	a.mu.RUnlock()
	if !ready || client == nil || client.Store.ID == nil || pairState == "relink_required" {
		apiError(w, 503, "account_link_required")
		return
	}
	if err = a.store.enqueue(r.Context(), post); err != nil {
		if errors.Is(err, errInvalid) {
			apiError(w, 409, "delivery_key_conflict")
		} else {
			apiError(w, 503, "queue_unavailable")
		}
		return
	}
	a.notify()
	writeJSON(w, 202, map[string]any{"ok": true, "delivery_key": post.Key, "state": "accepted"})
}

func (a *app) status(w http.ResponseWriter, r *http.Request) {
	value, err := a.state(r.Context())
	if err != nil {
		apiError(w, 503, "database_unavailable")
		return
	}
	targets, err := a.store.destinations(r.Context())
	if err != nil {
		apiError(w, 503, "database_unavailable")
		return
	}
	value["destinations"] = targets
	writeJSON(w, 200, value)
}

func (a *app) link(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Consent bool `json:"consent"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil || decodeStrict(raw, &input) != nil || !input.Consent {
		apiError(w, 400, "explicit_consent_required")
		return
	}
	if err := a.beginLink(); err != nil {
		apiError(w, 503, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *app) beginLink() error {
	a.mu.Lock()
	if !a.ready || a.client == nil {
		a.mu.Unlock()
		return errors.New("relay_starting")
	}
	if a.client.Store.ID != nil {
		a.mu.Unlock()
		return errors.New("already_linked")
	}
	if a.pairing {
		a.mu.Unlock()
		return nil
	}
	a.pairing = true
	a.pairState = "waiting_for_scan"
	a.pairError = ""
	client := a.client
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	client.Disconnect()
	channel, err := client.GetQRChannel(ctx)
	if err != nil {
		cancel()
		a.mu.Lock()
		a.pairing = false
		a.pairState = "link_failed"
		a.mu.Unlock()
		return errors.New("link_failed")
	}
	go func() {
		defer cancel()
		defer func() {
			a.mu.Lock()
			a.pairing = false
			a.qr = ""
			if a.pairState == "waiting_for_scan" || a.pairState == "waiting_for_phone_code" {
				a.pairState = "link_expired"
			}
			a.mu.Unlock()
		}()
		for event := range channel {
			a.mu.Lock()
			if event.Event == "code" {
				a.qr = event.Code
				a.qrExpiry = time.Now().Add(event.Timeout)
			} else if event.Event == "success" {
				a.qr = ""
				a.pairState = "linked"
				a.pairError = ""
			} else if event.Event == "passkey-request" {
				a.qr = ""
				a.pairState = "passkey_required"
				a.pairError = "passkey_required"
			} else if event.Event == "passkey-confirmation" {
				a.qr = ""
				a.pairState = "passkey_confirmation_required"
				a.pairError = "passkey_confirmation_required"
			} else {
				a.qr = ""
				a.pairState = "link_failed"
				if event.Error != nil {
					a.pairError = pairingErrorCode(event.Error)
				} else if a.pairError == "" {
					a.pairError = "pair_timeout"
				}
			}
			a.mu.Unlock()
		}
	}()
	if client.Connect() != nil {
		cancel()
		return errors.New("link_failed")
	}
	return nil
}

func (a *app) qrImage(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	code, expiry := a.qr, a.qrExpiry
	a.mu.RUnlock()
	if code == "" || time.Now().After(expiry) {
		apiError(w, 404, "qr_not_ready")
		return
	}
	png, err := qrcode.Encode(code, qrcode.Medium, 320)
	if err != nil {
		apiError(w, 503, "qr_unavailable")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Write(png)
}

func (a *app) groups(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	client := a.client
	a.mu.RUnlock()
	if client == nil || !client.IsLoggedIn() {
		apiError(w, 503, "account_link_required")
		return
	}
	groups, err := client.GetJoinedGroups(r.Context())
	if err != nil {
		apiError(w, 503, "groups_unavailable")
		return
	}
	out := []map[string]string{}
	for _, g := range groups {
		out = append(out, map[string]string{"id": g.JID.String(), "name": g.Name})
	}
	writeJSON(w, 200, map[string]any{"ok": true, "groups": out})
}

func (a *app) targets(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Phones []string `json:"phones"`
		Groups []string `json:"groups"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil || decodeStrict(raw, &input) != nil {
		apiError(w, 400, "invalid_payload")
		return
	}
	targets, err := parseDestinations(input.Phones, input.Groups)
	if err != nil {
		apiError(w, 400, "invalid_destinations")
		return
	}
	a.mu.RLock()
	client := a.client
	a.mu.RUnlock()
	if client == nil || !client.IsLoggedIn() {
		apiError(w, 503, "account_link_required")
		return
	}
	if len(input.Groups) > 0 {
		groups, err := client.GetJoinedGroups(r.Context())
		if err != nil {
			apiError(w, 503, "groups_unavailable")
			return
		}
		joined := map[string]bool{}
		for _, g := range groups {
			joined[g.JID.String()] = true
		}
		for _, group := range input.Groups {
			if !joined[group] {
				apiError(w, 400, "group_not_joined")
				return
			}
		}
	}
	if len(input.Phones) > 0 {
		registered, err := client.IsOnWhatsApp(r.Context(), input.Phones)
		if err != nil {
			apiError(w, 503, "number_check_unavailable")
			return
		}
		valid := map[string]bool{}
		for _, number := range registered {
			if number.IsIn {
				valid[strings.TrimPrefix(number.Query, "+")] = true
			}
		}
		for _, phone := range input.Phones {
			if !valid[strings.TrimPrefix(phone, "+")] {
				apiError(w, 400, "number_not_on_whatsapp")
				return
			}
		}
	}
	if a.store.saveDestinations(r.Context(), targets) != nil {
		apiError(w, 503, "database_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "destination_count": len(targets)})
}
