package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"
)

// Session locks can survive a disconnected client in an external SQL pooler.
// An expiring row lease survives cloud restarts without retaining such a lock.
func (s *storage) ensureLeaseTable(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS relay_worker_lease (id integer PRIMARY KEY CHECK(id=1), owner text NOT NULL, expires_at timestamptz NOT NULL);
ALTER TABLE relay_worker_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relay_worker_lease FROM PUBLIC, anon, authenticated;`)
	return err
}

func leaseOwner() string {
	var value [16]byte
	rand.Read(value[:])
	return hex.EncodeToString(value[:])
}

func (s *storage) claimLease(ctx context.Context, owner string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `INSERT INTO relay_worker_lease(id,owner,expires_at) VALUES(1,$1,now()+interval '45 seconds') ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at WHERE relay_worker_lease.expires_at<now()`, owner)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func (s *storage) renewLease(ctx context.Context, owner string) (bool, error) {
	result, err := s.db.ExecContext(ctx, "UPDATE relay_worker_lease SET expires_at=now()+interval '45 seconds' WHERE id=1 AND owner=$1 AND expires_at>now()", owner)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func (s *storage) releaseLease(ctx context.Context, owner string) {
	s.db.ExecContext(ctx, "DELETE FROM relay_worker_lease WHERE id=1 AND owner=$1", owner)
}

func (a *app) supervise(ctx context.Context) {
	for ctx.Err() == nil {
		a.run(ctx)
		a.mu.Lock()
		a.ready = false
		a.qr = ""
		a.pairing = false
		a.pairState = "starting"
		a.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}
