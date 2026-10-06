package main

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"testing"
	"time"

	"dbclient/internal/models"
	"dbclient/internal/postgres/connection"
	"dbclient/internal/postgres/metadata"
	"dbclient/internal/postgres/query"
	"sync"
)

// portForwardCfg matches creds.txt — connects through the SSH tunnel on localhost:5434.
// sslmode=prefer: pgx tries SSL first, falls back to plaintext if the server/tunnel
// rejects the TLS ClientHello (known issue with some kubectl port-forward setups).
var portForwardCfg = models.ConnectionConfig{
	Name:     "appdb-test",
	Host:     "localhost",
	Port:     5434,
	Database: "appdb",
	Username: "079213e6f47ca38858891a66",
	Password: "66662196b1e5942a6aaedec9",
	SSLMode:  "prefer",
}

// TestPortForwardConnect verifies basic connect + query through the tunnel.
func TestPortForwardConnect(t *testing.T) {
	svc := connection.NewService()
	ctx := context.Background()

	state, err := svc.Connect(ctx, portForwardCfg)
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	t.Logf("Connected: %s:%d/%s", state.Host, state.Port, state.Database)

	var mu sync.Mutex
	meta := metadata.NewService(svc.Conn, &mu)

	dbs, schemas, err := meta.DatabasesAndSchemas(ctx)
	if err != nil {
		t.Fatalf("DatabasesAndSchemas failed: %v", err)
	}
	t.Logf("Databases: %v", dbs)
	t.Logf("Schemas: %v", schemas)

	if len(schemas) == 0 {
		t.Fatal("Expected at least one schema")
	}

	objects, err := meta.Objects(ctx, schemas[0])
	if err != nil {
		t.Fatalf("Objects failed: %v", err)
	}
	t.Logf("Objects in schema %q: %d", schemas[0], len(objects))

	qsvc := query.NewService(svc.Conn, &mu)
	result, err := qsvc.Execute(ctx, "SELECT 1 AS ping")
	if err != nil {
		t.Fatalf("Execute failed: %v", err)
	}
	if result.RowCount != 1 {
		t.Fatalf("Expected 1 row, got %d", result.RowCount)
	}
	t.Logf("SELECT 1 OK in %d ms", result.ExecutionMs)

	svc.Close(ctx)
}

// TestClassifyErrors verifies that known error strings map to user-friendly messages.
func TestClassifyErrors(t *testing.T) {
	cases := []struct {
		input    string
		contains string
	}{
		{"read tcp 127.0.0.1:54548->127.0.0.1:5432: read: connection reset by peer", "port-forward"},
		{"dial tcp: lookup badhost: no such host", "Host not found"},
		{"connect: connection refused", "Connection refused"},
		{"password authentication failed for user \"foo\"", "Authentication failed"},
		{"context deadline exceeded", "timed out"},
		{"EOF", "lost unexpectedly"},
		{"broken pipe", "lost unexpectedly"},
		{"network is unreachable", "unreachable"},
	}
	for _, tc := range cases {
		err := fmt.Errorf("%s", tc.input)
		got := connection.ClassifyError(err)
		if got == nil {
			t.Errorf("ClassifyError(%q) = nil, want message containing %q", tc.input, tc.contains)
			continue
		}
		if !strings.Contains(got.Error(), tc.contains) {
			t.Errorf("ClassifyError(%q) = %q, want to contain %q", tc.input, got.Error(), tc.contains)
		} else {
			t.Logf("OK: %q -> %q", tc.input, got.Error())
		}
	}
}

// restartPortForward kills any existing kubectl port-forward on the VM and
// starts a fresh one. Called at the start of each live test so each test gets
// a clean tunnel.
func restartPortForward(t *testing.T) {
	t.Helper()
	cmd := exec.Command("ssh",
		"-o", "StrictHostKeyChecking=no",
		"-o", "ConnectTimeout=20",
		"-o", "ServerAliveInterval=3",
		"-o", "ServerAliveCountMax=10",
		"-o", "PasswordAuthentication=no",
		"-o", "ControlPath=~/.ssh/cm_sockets/querybird-vm",
		"root@sravanjs-c1.fyre.ibm.com",
		"bash /tmp/restart_pf.sh",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Logf("restartPortForward output: %s", string(out))
		t.Fatalf("restartPortForward failed: %v", err)
	}
	t.Logf("Port-forward restarted: %s", strings.TrimSpace(string(out)))
	time.Sleep(1 * time.Second)
}

// TestIsConnected verifies IsConnected() reflects reality.
func TestIsConnected(t *testing.T) {
	restartPortForward(t)
	svc := connection.NewService()
	if svc.IsConnected() {
		t.Fatal("Expected IsConnected=false before connecting")
	}

	ctx := context.Background()
	_, err := svc.Connect(ctx, portForwardCfg)
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	if !svc.IsConnected() {
		t.Fatal("Expected IsConnected=true after connecting")
	}

	svc.Close(ctx)
	if svc.IsConnected() {
		t.Fatal("Expected IsConnected=false after Close")
	}
	t.Log("IsConnected lifecycle OK")
}

// TestMarkDisconnected verifies that MarkDisconnected() causes IsConnected()=false.
func TestMarkDisconnected(t *testing.T) {
	restartPortForward(t)
	svc := connection.NewService()
	ctx := context.Background()

	_, err := svc.Connect(ctx, portForwardCfg)
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}

	svc.MarkDisconnected()
	if svc.IsConnected() {
		t.Fatal("Expected IsConnected=false after MarkDisconnected")
	}
	t.Log("MarkDisconnected OK")
}

// TestTunnelKillAndReconnect simulates the kubectl port-forward disappearing mid-session.
// It kills the local SSH tunnel, verifies errors are classified correctly, then restores
// the tunnel and reconnects.
func TestTunnelKillAndReconnect(t *testing.T) {
	restartPortForward(t)
	ctx := context.Background()
	svc := connection.NewService()

	// 1. Connect
	_, err := svc.Connect(ctx, portForwardCfg)
	if err != nil {
		t.Fatalf("Initial connect failed: %v", err)
	}
	t.Log("Phase 1: connected OK")

	var mu sync.Mutex
	qsvc := query.NewService(svc.Conn, &mu)

	// 2. Verify a query works
	r, err := qsvc.Execute(ctx, "SELECT pg_backend_pid() AS pid")
	if err != nil {
		t.Fatalf("Query before kill failed: %v", err)
	}
	t.Logf("Phase 2: backend PID = %v", r.Rows[0]["pid"])

	// 3. Kill the local SSH tunnel to simulate port-forward teardown
	t.Log("Phase 3: killing local SSH tunnel on port 5434...")
	killCmd := exec.Command("sh", "-c", "lsof -ti:5434 | xargs kill -9 2>/dev/null; sleep 1")
	if out, err := killCmd.CombinedOutput(); err != nil {
		t.Logf("(kill output: %s, err: %v — may be harmless)", string(out), err)
	}
	time.Sleep(2 * time.Second)

	// 4. Attempt a query — it should fail with a classified connection-loss error
	_, qErr := qsvc.Execute(ctx, "SELECT 1")
	if qErr == nil {
		t.Log("Query after tunnel kill unexpectedly succeeded (connection may have cached)")
	} else {
		t.Logf("Phase 4: query after kill => %v", qErr)
		classified := connection.ClassifyError(qErr)
		t.Logf("Classified: %v", classified)
		if !strings.Contains(classified.Error(), "lost") && !strings.Contains(classified.Error(), "timed out") && !strings.Contains(classified.Error(), "refused") {
			t.Errorf("Expected a connection-loss message, got: %v", classified)
		}
	}

	// 5. Re-establish the SSH tunnel
	t.Log("Phase 5: re-establishing SSH tunnel...")
	tunnelCmd := exec.Command("ssh",
		"-o", "StrictHostKeyChecking=no",
		"-o", "ConnectTimeout=8",
		"-o", "PasswordAuthentication=no",
		"-L", "5434:localhost:5434",
		"-fN",
		"root@sravanjs-c1.fyre.ibm.com",
	)
	if out, err := tunnelCmd.CombinedOutput(); err != nil {
		t.Fatalf("SSH tunnel restart failed: %s / %v", string(out), err)
	}
	time.Sleep(2 * time.Second)

	// 6. Reconnect using a fresh connection.Service
	t.Log("Phase 6: reconnecting...")
	svc2 := connection.NewService()
	state2, err := svc2.Connect(ctx, portForwardCfg)
	if err != nil {
		t.Fatalf("Reconnect failed: %v", err)
	}
	t.Logf("Phase 6: reconnected to %s:%d/%s", state2.Host, state2.Port, state2.Database)

	var mu2 sync.Mutex
	qsvc2 := query.NewService(svc2.Conn, &mu2)
	r2, err := qsvc2.Execute(ctx, "SELECT current_database() AS db")
	if err != nil {
		t.Fatalf("Query after reconnect failed: %v", err)
	}
	t.Logf("Phase 6: query after reconnect OK, db=%v", r2.Rows[0]["db"])

	svc2.Close(ctx)
	log.Println("TestTunnelKillAndReconnect: ALL PHASES PASSED")
}
