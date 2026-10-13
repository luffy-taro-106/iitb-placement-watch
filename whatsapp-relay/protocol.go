package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"
)

var errInvalid = errors.New("invalid_request")
var hex64 = regexp.MustCompile(`^[a-f0-9]{64}$`)
var noncePattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var postPattern = regexp.MustCompile(`^post-[0-9]+$`)
var phonePattern = regexp.MustCompile(`^\+[1-9][0-9]{7,14}$`)
var groupPattern = regexp.MustCompile(`^[0-9]+(?:-[0-9]+)?@g\.us$`)

const blogURL = "https://campus.placements.iitb.ac.in/blog/placement/"

type envelope struct {
	Action    string          `json:"action"`
	Nonce     string          `json:"nonce"`
	IssuedAt  int64           `json:"issued_at"`
	Payload   json.RawMessage `json:"payload"`
	Signature string          `json:"signature"`
}

type announcement struct {
	Key         string `json:"delivery_key"`
	PostID      string `json:"post_id"`
	Fingerprint string `json:"fingerprint"`
	Title       string `json:"title"`
	Text        string `json:"text"`
	SourceURL   string `json:"source_url"`
}

func decodeStrict(raw []byte, output any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(output); err != nil {
		return errInvalid
	}
	if d.Decode(new(any)) != io.EOF {
		return errInvalid
	}
	return nil
}

func authenticate(raw []byte, secret string, now time.Time) (envelope, error) {
	var e envelope
	if decodeStrict(raw, &e) != nil || (e.Action != "deliver" && e.Action != "status") || !noncePattern.MatchString(e.Nonce) || !hex64.MatchString(e.Signature) || now.Unix()-e.IssuedAt > 300 || e.IssuedAt-now.Unix() > 60 {
		return e, errInvalid
	}
	if len(e.Payload) == 0 || e.Payload[0] != '{' {
		return e, errInvalid
	}
	// Preserve JavaScript JSON.stringify escaping and object order. Go's default
	// marshaler escapes &, <, > and Unicode separators differently.
	var compact bytes.Buffer
	if json.Compact(&compact, e.Payload) != nil {
		return e, errInvalid
	}
	canonical := fmt.Sprintf(`["%s","%s",%d,%s]`, e.Action, e.Nonce, e.IssuedAt, compact.Bytes())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	sig, _ := hex.DecodeString(e.Signature)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return e, errInvalid
	}
	return e, nil
}

func validateAnnouncement(a announcement) error {
	if !postPattern.MatchString(a.PostID) || !hex64.MatchString(a.Fingerprint) || a.Key != a.PostID+":"+a.Fingerprint || strings.TrimSpace(a.Title) == "" || len(a.Title) > 4000 || len(a.Text) > 50000 || strings.TrimSpace(a.Text) == "" || a.SourceURL != blogURL+"?p="+strings.TrimPrefix(a.PostID, "post-") {
		return errInvalid
	}
	return nil
}

func parseDestinations(phones, groups []string) ([]string, error) {
	if len(phones)+len(groups) < 1 || len(phones)+len(groups) > 20 {
		return nil, errInvalid
	}
	seen := map[string]bool{}
	var result []string
	for _, phone := range phones {
		if !phonePattern.MatchString(phone) {
			return nil, errInvalid
		}
		jid := strings.TrimPrefix(phone, "+") + "@s.whatsapp.net"
		if seen[jid] {
			return nil, errInvalid
		}
		seen[jid] = true
		result = append(result, jid)
	}
	for _, group := range groups {
		if !groupPattern.MatchString(group) || seen[group] {
			return nil, errInvalid
		}
		seen[group] = true
		result = append(result, group)
	}
	return result, nil
}

func validTarget(jid string) bool {
	if groupPattern.MatchString(jid) {
		return true
	}
	parsed, err := types.ParseJID(jid)
	return err == nil && parsed.Server == types.DefaultUserServer && phonePattern.MatchString("+"+parsed.User) && parsed.Device == 0 && parsed.RawAgent == 0 && parsed.Integrator == 0
}

func messageText(a announcement) string {
	return a.Title + "\n\n" + a.Text + "\n\nPlacement blog: " + a.SourceURL
}
