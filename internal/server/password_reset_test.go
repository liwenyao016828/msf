package server

import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestResetAdminPasswordTargetsOneAccountAndInvalidatesSessions(t *testing.T) {
	app := newTestApp(t)
	if err := app.createOrUpdateAdmin("alice", "old-password-123", ""); err != nil {
		t.Fatal(err)
	}
	if err := app.createOrUpdateAdmin("bob", "bob-password-123", ""); err != nil {
		t.Fatal(err)
	}
	alice, _, err := app.findUserByUsername("alice")
	if err != nil {
		t.Fatal(err)
	}
	oldJWT, err := app.makeToken(alice, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	refreshSecret := "alice-refresh-secret"
	refreshHash := tokenHash(refreshSecret)
	if _, err := app.DB.Exec(`insert into refresh_tokens(user_id,token_hash,auth_version,expires_at,created_at) values(?,?,?,?,?)`, alice.ID, refreshHash, alice.AuthVersion, time.Now().Add(time.Hour), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(`insert into api_tokens(user_id,name,token_hash,scope,created_at,revoked) values(?,?,?,?,?,false)`, alice.ID, "automation", "alice-api-token", "admin", time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := app.ResetAdminPassword("alice", "new-password-456"); err != nil {
		t.Fatal(err)
	}
	aliceAfter, aliceHash, err := app.findUserByUsername("alice")
	if err != nil {
		t.Fatal(err)
	}
	_, bobHash, err := app.findUserByUsername("bob")
	if err != nil {
		t.Fatal(err)
	}
	if !passwordMatches(aliceHash, "new-password-456") || passwordMatches(aliceHash, "old-password-123") {
		t.Fatal("target administrator password was not replaced")
	}
	if !passwordMatches(bobHash, "bob-password-123") {
		t.Fatal("non-target administrator password changed")
	}
	if aliceAfter.AuthVersion != alice.AuthVersion+1 {
		t.Fatalf("auth version=%d, want %d", aliceAfter.AuthVersion, alice.AuthVersion+1)
	}
	if _, err := app.authenticateJWT(oldJWT); err == nil || !strings.Contains(err.Error(), "invalidated") {
		t.Fatalf("old access token should be invalidated, got %v", err)
	}
	newJWT, err := app.makeToken(aliceAfter, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.authenticateJWT(newJWT); err != nil {
		t.Fatalf("new access token should authenticate: %v", err)
	}
	var refreshRevoked, apiTokenRevoked bool
	if err := app.DB.QueryRow(`select revoked from refresh_tokens where token_hash=?`, refreshHash).Scan(&refreshRevoked); err != nil {
		t.Fatal(err)
	}
	if err := app.DB.QueryRow(`select revoked from api_tokens where token_hash='alice-api-token'`).Scan(&apiTokenRevoked); err != nil {
		t.Fatal(err)
	}
	if !refreshRevoked {
		t.Fatal("refresh token was not revoked")
	}
	if refresh := requestJSON(t, app, http.MethodPost, "/api/v1/auth/refresh", refreshSecret, nil); refresh.Code != http.StatusUnauthorized {
		t.Fatalf("old refresh token status=%d body=%s, want 401", refresh.Code, refresh.Body.String())
	}
	if apiTokenRevoked {
		t.Fatal("password reset should not silently revoke separate API credentials")
	}
}

func TestUserPasswordResetAPIRequiresPasswordAndHidesIt(t *testing.T) {
	app := newTestApp(t)
	if err := app.createOrUpdateAdmin("admin", "admin-password-123", ""); err != nil {
		t.Fatal(err)
	}
	admin, _, err := app.findUserByUsername("admin")
	if err != nil {
		t.Fatal(err)
	}
	adminJWT, err := app.makeToken(admin, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	res, err := app.DB.Exec(`insert into users(username,password,role,is_active,created_at,updated_at) values('operator','x','operator',true,?,?)`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	targetID, _ := res.LastInsertId()
	path := "/api/v1/users/" + strconv.FormatInt(targetID, 10) + "/reset-password"

	missing := requestJSON(t, app, http.MethodPost, path, adminJWT, map[string]any{})
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing password status=%d body=%s", missing.Code, missing.Body.String())
	}
	reset := requestJSON(t, app, http.MethodPost, path, adminJWT, map[string]any{"password": "operator-password-456"})
	if reset.Code != http.StatusOK {
		t.Fatalf("reset status=%d body=%s", reset.Code, reset.Body.String())
	}
	if strings.Contains(reset.Body.String(), "operator-password-456") || strings.Contains(reset.Body.String(), "plain_password") {
		t.Fatalf("reset response exposed the password: %s", reset.Body.String())
	}
}

func TestResetAdminPasswordValidatesTargetAndPassword(t *testing.T) {
	app := newTestApp(t)
	now := time.Now()
	if _, err := app.DB.Exec(`insert into users(username,password,role,is_active,created_at,updated_at) values('operator','x','operator',true,?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name     string
		username string
		password string
		want     string
	}{
		{name: "missing", username: "missing", password: "long-enough-password", want: "not found"},
		{name: "not admin", username: "operator", password: "long-enough-password", want: "not an administrator"},
		{name: "short password", username: "operator", password: "short", want: "not an administrator"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := app.ResetAdminPassword(tc.username, tc.password)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error=%v, want substring %q", err, tc.want)
			}
		})
	}
	if err := validateNewPassword("short"); err == nil {
		t.Fatal("short password should be rejected")
	}
	if err := validateNewPassword("        "); err == nil {
		t.Fatal("blank password should be rejected")
	}
}

func TestUserAuthVersionMigrationSupportsExistingDatabase(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "database"), 0755); err != nil {
		t.Fatal(err)
	}
	legacy, err := sql.Open("sqlite", filepath.Join(dataDir, "database", "msf.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`create table users (
		id integer primary key autoincrement,
		username text not null unique,
		password text not null,
		email text,
		display_name text,
		role text default 'operator',
		is_active numeric default true,
		last_login datetime,
		failed_attempts integer default 0,
		locked_until datetime,
		created_at datetime,
		updated_at datetime,
		deleted_at datetime
	)`); err != nil {
		legacy.Close()
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`create table refresh_tokens (
		id integer primary key autoincrement,
		user_id integer not null,
		token_hash text not null,
		expires_at datetime,
		revoked numeric default false,
		created_at datetime
	)`); err != nil {
		legacy.Close()
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	app, err := New(Options{DataDir: dataDir, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if !tableHasColumn(t, app.DB, "users", "auth_version") {
		t.Fatal("users.auth_version migration is missing")
	}
	if !tableHasColumn(t, app.DB, "refresh_tokens", "auth_version") {
		t.Fatal("refresh_tokens.auth_version migration is missing")
	}
}

func tableHasColumn(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()
	rows, err := db.Query(`pragma table_info(` + table + `)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			t.Fatal(err)
		}
		if name == column {
			return true
		}
	}
	return false
}
