package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"go.mau.fi/whatsmeow"
)

func TestPairingDiagnosticsNeverExposePrivateErrorText(t *testing.T) {
	secret := "private account and key material must not leak"
	for _, input := range []error{errors.New(secret), &whatsmeow.PairDatabaseError{Message: secret, DBErr: &pgconn.PgError{Code: "23502", Message: secret}}, &whatsmeow.PairProtoError{Message: secret, ProtoErr: errors.New(secret)}} {
		code := pairingErrorCode(input)
		if strings.Contains(code, "private") || len(code) > 60 {
			t.Fatal("unsafe pairing diagnosis")
		}
	}
	if pairingErrorCode(&whatsmeow.PairDatabaseError{DBErr: &pgconn.PgError{Code: "23502"}}) != "pair_database_23502" {
		t.Fatal("database stage lost")
	}
	if pairingErrorCode(context.DeadlineExceeded) != "pair_timeout" {
		t.Fatal("timeout not identified")
	}
	if pairingErrorCode(whatsmeow.ErrPairInvalidDeviceIdentityHMAC) != "pair_identity_hmac_rejected" {
		t.Fatal("identity check not identified")
	}
}
