package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"
)

func signFixture(action, nonce string, at int64, payload string) []byte {
	mac := hmac.New(sha256.New, []byte(strings.Repeat("a", 64)))
	mac.Write([]byte(fmt.Sprintf(`["%s","%s",%d,%s]`, action, nonce, at, payload)))
	return []byte(fmt.Sprintf(`{"action":%q,"nonce":%q,"issued_at":%d,"payload":%s,"signature":%q}`, action, nonce, at, payload, hex.EncodeToString(mac.Sum(nil))))
}

func TestJavaScriptCanonicalAndTamper(t *testing.T) {
	now := time.Unix(1800000000, 0)
	nonce := strings.Repeat("b", 32)
	payload := `{"title":"Sony & Japan <JAF> Open","url":"https://example.test/?a=1&b=2"}`
	good := signFixture("deliver", nonce, now.Unix(), payload)
	if _, err := authenticate(good, strings.Repeat("a", 64), now); err != nil {
		t.Fatal(err)
	}
	if _, err := authenticate([]byte(strings.Replace(string(good), "Sony", "Changed", 1)), strings.Repeat("a", 64), now); err == nil {
		t.Fatal("tampered content accepted")
	}
	if _, err := authenticate(good, strings.Repeat("c", 64), now); err == nil {
		t.Fatal("wrong key accepted")
	}
}

func TestEnvelopeLimits(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, at := range []int64{now.Unix() - 301, now.Unix() + 61} {
		if _, err := authenticate(signFixture("status", strings.Repeat("b", 32), at, `{}`), strings.Repeat("a", 64), now); err == nil {
			t.Fatal("expired request accepted")
		}
	}
	for _, action := range []string{"get_session", "save_session", "groups", "link"} {
		if _, err := authenticate(signFixture(action, strings.Repeat("b", 32), now.Unix(), `{}`), strings.Repeat("a", 64), now); err == nil {
			t.Fatal("admin action accepted")
		}
	}
	if _, err := authenticate(append(signFixture("status", strings.Repeat("b", 32), now.Unix(), `{}`), []byte(`{}`)...), strings.Repeat("a", 64), now); err == nil {
		t.Fatal("trailing content accepted")
	}
}

func TestDestinationAuthorizationShape(t *testing.T) {
	valid, err := parseDestinations([]string{"+919000000001"}, []string{"1234567890@g.us"})
	if err != nil || len(valid) != 2 || valid[0] != "919000000001@s.whatsapp.net" {
		t.Fatal("both destination kinds not supported")
	}
	for _, bad := range []string{"9000000001", "+0919000000001", "+91 9000000001", "+919000000001@evil", "someone@gmail.com"} {
		if _, err = parseDestinations([]string{bad}, nil); err == nil {
			t.Fatal("invalid number accepted")
		}
	}
	for _, bad := range []string{"1234567890@broadcast", "1234567890@newsletter", "1234567890@s.whatsapp.net"} {
		if _, err = parseDestinations(nil, []string{bad}); err == nil {
			t.Fatal("non-group accepted")
		}
	}
	if _, err = parseDestinations([]string{"+919000000001", "+919000000001"}, nil); err == nil {
		t.Fatal("duplicate number accepted")
	}
	if _, err = parseDestinations(nil, nil); err == nil {
		t.Fatal("empty targets accepted")
	}
}

func TestAnnouncementSourceAndRevision(t *testing.T) {
	a := announcement{Key: "post-42:" + strings.Repeat("c", 64), PostID: "post-42", Fingerprint: strings.Repeat("c", 64), Title: "Sony Japan | JAF Open", Text: "Deadline: 14 October, 11:59 PM IST\nMeeting: https://meet.google.com/abc-defg-hij", SourceURL: blogURL + "?p=42"}
	if validateAnnouncement(a) != nil {
		t.Fatal("valid announcement rejected")
	}
	if !strings.Contains(messageText(a), "Deadline:") || !strings.Contains(messageText(a), "https://meet.google.com/abc-defg-hij") {
		t.Fatal("useful content dropped")
	}
	a.SourceURL = "https://attacker.test/"
	if validateAnnouncement(a) == nil {
		t.Fatal("arbitrary source accepted")
	}
	a.SourceURL = blogURL + "?p=42"
	a.Key = "post-42:other"
	if validateAnnouncement(a) == nil {
		t.Fatal("revision mismatch accepted")
	}
}
