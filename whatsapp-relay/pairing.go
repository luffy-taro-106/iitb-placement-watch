package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"go.mau.fi/whatsmeow"
)

var sqlStatePattern = regexp.MustCompile(`^[A-Z0-9]{5}$`)

// Never return raw SDK errors: they can contain account IDs or key material.
func pairingErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var database *whatsmeow.PairDatabaseError
	var sqlError *pgconn.PgError
	var protocol *whatsmeow.PairProtoError
	if errors.As(err, &database) {
		if errors.As(err, &sqlError) && sqlStatePattern.MatchString(sqlError.Code) {
			return "pair_database_" + sqlError.Code
		}
		return "pair_database_error"
	}
	if errors.As(err, &protocol) {
		return "pair_protocol_error"
	}
	if errors.Is(err, whatsmeow.ErrPairInvalidDeviceIdentityHMAC) {
		return "pair_identity_hmac_rejected"
	}
	if errors.Is(err, whatsmeow.ErrPairInvalidDeviceSignature) {
		return "pair_identity_signature_rejected"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "pair_timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "pair_cancelled"
	}
	return "pair_connection_rejected"
}

func (a *app) recordPairError(code string) {
	a.mu.Lock()
	a.qr = ""
	a.pairError = code
	a.mu.Unlock()
}

func (a *app) phoneLink(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Consent bool   `json:"consent"`
		Phone   string `json:"phone"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil || decodeStrict(raw, &input) != nil || !input.Consent || !phonePattern.MatchString(input.Phone) {
		apiError(w, 400, "explicit_sender_number_and_consent_required")
		return
	}
	if err = a.beginLink(); err != nil {
		apiError(w, 503, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		a.mu.RLock()
		client, ready, expiry, code, state := a.client, a.ready, a.qrExpiry, a.qr, a.pairState
		a.mu.RUnlock()
		if client != nil && ready && code != "" && time.Now().Before(expiry) {
			pairCode, err := client.PairPhone(ctx, input.Phone, false, whatsmeow.PairClientChrome, "Chrome (Linux)")
			if err != nil {
				a.recordPairError(pairingErrorCode(err))
				apiError(w, 503, "phone_link_rejected")
				return
			}
			if !regexp.MustCompile(`^[A-Z0-9-]{8,12}$`).MatchString(pairCode) {
				apiError(w, 503, "invalid_pairing_code")
				return
			}
			a.mu.Lock()
			a.qr = ""
			a.pairState = "waiting_for_phone_code"
			a.mu.Unlock()
			writeJSON(w, 200, map[string]any{"ok": true, "pairing_code": pairCode})
			return
		}
		if strings.HasPrefix(state, "passkey") || state == "link_failed" || state == "link_expired" {
			apiError(w, 503, "phone_link_needs_review")
			return
		}
		select {
		case <-ctx.Done():
			apiError(w, 503, "phone_link_not_ready")
			return
		case <-ticker.C:
		}
	}
}
