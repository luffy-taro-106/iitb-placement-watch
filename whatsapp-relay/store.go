package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/whatsmeow/store/sqlstore"
)

const relaySchema = "whatsapp_relay"

// Supabase's public root CA downloaded from its authenticated dashboard link.
// Explicit trust preserves full chain and hostname checks on macOS and Linux.
//
//go:embed supabase-ca.crt
var supabaseRootCA []byte

type storage struct{ db *sql.DB }

func openStorage(ctx context.Context, dsn string) (*storage, error) {
	conf, err := pgx.ParseConfig(dsn)
	if err != nil || conf.TLSConfig == nil || conf.TLSConfig.InsecureSkipVerify || len(conf.Fallbacks) > 0 || (conf.User != "placement_wa" && !strings.HasPrefix(conf.User, "placement_wa.")) {
		return nil, errors.New("private_verified_database_required")
	}
	root := x509.NewCertPool()
	if !root.AppendCertsFromPEM(supabaseRootCA) {
		return nil, errors.New("database_ca_invalid")
	}
	conf.TLSConfig.RootCAs = root
	conf.RuntimeParams["search_path"] = relaySchema
	db := stdlib.OpenDB(*conf)
	db.SetMaxOpenConns(3)
	db.SetMaxIdleConns(3)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		var unknown x509.UnknownAuthorityError
		var cert x509.CertificateInvalidError
		var host x509.HostnameError
		var database *pgconn.PgError
		if errors.As(err, &unknown) {
			return nil, errors.New("database_ca_required")
		}
		if errors.As(err, &cert) || errors.As(err, &host) {
			return nil, errors.New("database_certificate_invalid")
		}
		if errors.As(err, &database) {
			return nil, errors.New("database_sqlstate_" + database.Code)
		}
		return nil, errors.New("database_unavailable")
	}
	var role string
	if db.QueryRowContext(ctx, "SELECT current_user").Scan(&role) != nil || role != "placement_wa" {
		db.Close()
		return nil, errors.New("private_database_role_required")
	}
	var owner string
	if db.QueryRowContext(ctx, "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=$1", relaySchema).Scan(&owner) != nil || owner != "placement_wa" {
		db.Close()
		return nil, errors.New("private_schema_required")
	}
	return &storage{db}, nil
}

func (s *storage) upgrade(ctx context.Context) (*sqlstore.Container, error) {
	container := sqlstore.NewWithDB(s.db, "postgres", nil)
	if err := container.Upgrade(ctx); err != nil {
		return nil, err
	}
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS relay_destinations (jid text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS relay_nonces (nonce text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS relay_announcements (delivery_key text PRIMARY KEY, body_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS relay_jobs (delivery_key text NOT NULL REFERENCES relay_announcements(delivery_key), jid text NOT NULL, message text NOT NULL, message_id text UNIQUE, state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','attempting','acknowledged','uncertain')), created_at timestamptz NOT NULL DEFAULT now(), attempted_at timestamptz, acknowledged_at timestamptz, receipt_at timestamptz, PRIMARY KEY(delivery_key,jid));
CREATE INDEX IF NOT EXISTS relay_jobs_pending ON relay_jobs(created_at) WHERE state='queued';`)
	if err != nil {
		return nil, err
	}
	// These tables are in an unexposed private schema. Their owner can use them;
	// all API roles have no grants and no RLS policies.
	rows, err := s.db.QueryContext(ctx, "SELECT tablename FROM pg_tables WHERE schemaname=$1", relaySchema)
	if err != nil {
		return nil, err
	}
	var names []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return nil, err
		}
		names = append(names, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		quoted := pgx.Identifier{relaySchema, name}.Sanitize()
		if _, err = s.db.ExecContext(ctx, "ALTER TABLE "+quoted+" ENABLE ROW LEVEL SECURITY; REVOKE ALL ON "+quoted+" FROM PUBLIC, anon, authenticated"); err != nil {
			return nil, err
		}
	}
	// Any interrupted send is uncertain, never returned to the send queue.
	_, err = s.db.ExecContext(ctx, "UPDATE relay_jobs SET state='uncertain' WHERE state='attempting'")
	return container, err
}

func (s *storage) consumeNonce(ctx context.Context, nonce string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM relay_nonces WHERE expires_at < now()")
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO relay_nonces(nonce,expires_at) VALUES($1,now()+interval '10 minutes')", nonce)
	return err
}

func (s *storage) destinations(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT jid FROM relay_destinations ORDER BY jid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var jid string
		if err = rows.Scan(&jid); err != nil {
			return nil, err
		}
		out = append(out, jid)
	}
	return out, rows.Err()
}

func (s *storage) saveDestinations(ctx context.Context, targets []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM relay_destinations"); err != nil {
		return err
	}
	for _, jid := range targets {
		if _, err = tx.ExecContext(ctx, "INSERT INTO relay_destinations(jid) VALUES($1)", jid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *storage) enqueue(ctx context.Context, a announcement) error {
	raw, _ := json.Marshal(a)
	hash := sha256.Sum256(raw)
	bodyHash := hex.EncodeToString(hash[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "INSERT INTO relay_announcements(delivery_key,body_hash) VALUES($1,$2) ON CONFLICT DO NOTHING", a.Key, bodyHash)
	if err != nil {
		return err
	}
	inserted, _ := result.RowsAffected()
	if inserted == 0 {
		var old string
		if tx.QueryRowContext(ctx, "SELECT body_hash FROM relay_announcements WHERE delivery_key=$1", a.Key).Scan(&old) != nil || old != bodyHash {
			return errInvalid
		}
		return tx.Commit()
	}
	rows, err := tx.QueryContext(ctx, "SELECT jid FROM relay_destinations ORDER BY jid")
	if err != nil {
		return err
	}
	var targets []string
	for rows.Next() {
		var target string
		if err = rows.Scan(&target); err != nil {
			rows.Close()
			return err
		}
		targets = append(targets, target)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		return errors.New("destinations_required")
	}
	for _, jid := range targets {
		if !validTarget(jid) {
			return errInvalid
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO relay_jobs(delivery_key,jid,message) VALUES($1,$2,$3)", a.Key, jid, messageText(a)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type job struct{ Key, JID, Message string }

func (s *storage) nextJob(ctx context.Context) (job, error) {
	var j job
	err := s.db.QueryRowContext(ctx, "SELECT delivery_key,jid,message FROM relay_jobs WHERE state='queued' ORDER BY created_at,delivery_key,jid LIMIT 1").Scan(&j.Key, &j.JID, &j.Message)
	return j, err
}

// This durable transition happens before the network send. A crash or an
// uncertain response cannot cause an automatic duplicate on restart.
func (s *storage) beginAttempt(ctx context.Context, j job, id string) (bool, error) {
	r, err := s.db.ExecContext(ctx, "UPDATE relay_jobs SET state='attempting',message_id=$3,attempted_at=now() WHERE delivery_key=$1 AND jid=$2 AND state='queued'", j.Key, j.JID, id)
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}
func (s *storage) finishAttempt(ctx context.Context, j job, acknowledged bool) error {
	state := "uncertain"
	if acknowledged {
		state = "acknowledged"
	}
	_, err := s.db.ExecContext(ctx, "UPDATE relay_jobs SET state=$3,acknowledged_at=CASE WHEN $3='acknowledged' THEN now() ELSE acknowledged_at END WHERE delivery_key=$1 AND jid=$2 AND state='attempting'", j.Key, j.JID, state)
	return err
}

func (s *storage) counts(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT state,count(*) FROM relay_jobs GROUP BY state")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{"queued": 0, "attempting": 0, "acknowledged": 0, "uncertain": 0}
	for rows.Next() {
		var state string
		var n int
		if err = rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		counts[state] = n
	}
	return counts, rows.Err()
}
