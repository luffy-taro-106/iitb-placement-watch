package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/types"
)

func TestHTTPProtectsControlsAndHealth(t *testing.T) {
	a := &app{adminSecret: strings.Repeat("a", 64), relaySecret: strings.Repeat("b", 64), origin: "https://fixture.onrender.com"}
	for _, path := range []string{"/api/status", "/api/groups", "/api/qr"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != 401 || !strings.Contains(w.Body.String(), "authentication_required") {
			t.Fatal("private controls exposed")
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatal("private response can leak")
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), "linked") || strings.Contains(w.Body.String(), a.adminSecret) {
		t.Fatal("health exposes private state")
	}
	r = httptest.NewRequest(http.MethodPost, "/api/link", strings.NewReader(`{"consent":true}`))
	r.Header.Set("Origin", "https://outsider.test")
	r.Header.Set("Authorization", "Bearer "+a.adminSecret)
	w = httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin mutation accepted")
	}
}

func TestRealPrivateDatabasePersistence(t *testing.T) {
	if os.Getenv("RUN_DB_TESTS") != "1" {
		t.Skip("explicit private database fixture test only")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	s, err := openStorage(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	container, err := s.upgrade(ctx)
	if err != nil {
		t.Fatal(err)
	}
	devices, err := container.GetAllDevices(ctx)
	if err != nil || len(devices) > 0 {
		t.Fatal("only run synthetic device-save test before account linkage")
	}
	device := container.NewDevice()
	id := types.NewJID("19999999990", types.DefaultUserServer)
	id.Device = 1
	device.ID = &id
	device.LID = types.NewJID("999999999999999", types.HiddenUserServer)
	device.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte("synthetic-not-a-whatsapp-account"), AccountSignature: make([]byte, 64), AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64)}
	if err = device.Save(ctx); err != nil {
		t.Fatal("synthetic linked-device persistence failed: " + pairingErrorCode(err))
	}
	defer device.Delete(context.Background())
	if err = device.Identities.PutIdentity(ctx, "synthetic-main-device", [32]byte{}); err != nil {
		t.Fatal("synthetic identity persistence failed")
	}
	if err = device.Delete(ctx); err != nil {
		t.Fatal("synthetic cleanup failed")
	}
	var bypass, createRole bool
	if s.db.QueryRowContext(ctx, "SELECT rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user").Scan(&bypass, &createRole) != nil || bypass || createRole {
		t.Fatal("overprivileged role")
	}
	var exposed int
	if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM pg_tables p WHERE schemaname='whatsapp_relay' AND (NOT rowsecurity OR has_table_privilege('anon',format('%I.%I',schemaname,tablename),'SELECT') OR has_table_privilege('authenticated',format('%I.%I',schemaname,tablename),'SELECT'))`).Scan(&exposed); err != nil || exposed != 0 {
		t.Fatal("private tables exposed")
	}
	targets, err := s.destinations(ctx)
	if err != nil || len(targets) > 0 {
		t.Fatal("run fixture only before recipient configuration")
	}
	key := "post-999999999:" + strings.Repeat("a", 64)
	nonce := strings.Repeat("f", 32)
	defer func() {
		s.db.ExecContext(context.Background(), "DELETE FROM relay_jobs WHERE delivery_key=$1", key)
		s.db.ExecContext(context.Background(), "DELETE FROM relay_announcements WHERE delivery_key=$1", key)
		s.db.ExecContext(context.Background(), "DELETE FROM relay_nonces WHERE nonce=$1", nonce)
		s.db.ExecContext(context.Background(), "DELETE FROM relay_destinations")
	}()
	if s.consumeNonce(ctx, nonce) != nil || s.consumeNonce(ctx, nonce) == nil {
		t.Fatal("nonce replay not rejected")
	}
	if s.saveDestinations(ctx, []string{"19999999990@s.whatsapp.net"}) != nil {
		t.Fatal("fixture destination not saved")
	}
	a := announcement{Key: key, PostID: "post-999999999", Fingerprint: strings.Repeat("a", 64), Title: "Synthetic fixture", Text: "Not sent to WhatsApp.", SourceURL: blogURL + "?p=999999999"}
	if s.enqueue(ctx, a) != nil {
		t.Fatal("durable enqueue failed")
	}
	if s.saveDestinations(ctx, []string{"19999999991@s.whatsapp.net"}) != nil || s.enqueue(ctx, a) != nil {
		t.Fatal("idempotent acceptance failed")
	}
	j, err := s.nextJob(ctx)
	if err != nil || j.JID != "19999999990@s.whatsapp.net" {
		t.Fatal("recipient snapshot changed")
	}
	a.Text = "different"
	if s.enqueue(ctx, a) == nil {
		t.Fatal("same key accepted changed body")
	}
	started, err := s.beginAttempt(ctx, j, "SYNTHETIC-NOT-SENT")
	if err != nil || !started {
		t.Fatal("attempt not durable")
	}
	if _, err = s.upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = s.nextJob(ctx); err != sql.ErrNoRows {
		t.Fatal("uncertain send requeued")
	}
	counts, err := s.counts(ctx)
	if err != nil || counts["uncertain"] != 1 {
		t.Fatal("uncertainty not preserved")
	}
}
