package connection

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"dbclient/internal/models"
)

// connectTimeout caps the entire PostgreSQL handshake (TCP + auth + startup).
// Distinct from the dial timeout so slow TLS/auth stages are also bounded.
const connectTimeout = 30 * time.Second

type Service struct {
	Conn *pgx.Conn
	Cfg  *models.ConnectionConfig
}

func NewService() *Service {
	return &Service{}
}

// IsConnected returns true when the connection exists and has not been closed.
func (s *Service) IsConnected() bool {
	return s.Conn != nil && !s.Conn.IsClosed()
}

func (s *Service) TestConnection(ctx context.Context, cfg models.ConnectionConfig) error {
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := s.openConn(ctx, cfg)
	if err != nil {
		return ClassifyError(err)
	}
	defer conn.Close(ctx)
	if err := conn.Ping(ctx); err != nil {
		return ClassifyError(err)
	}
	return nil
}

func (s *Service) Connect(ctx context.Context, cfg models.ConnectionConfig) (*models.ConnectionState, error) {
	log.Printf("[QueryBird] Connecting to %s:%d/%s as %s", cfg.Host, cfg.Port, cfg.Database, cfg.Username)

	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()

	conn, err := s.openConn(ctx, cfg)
	if err != nil {
		log.Printf("[QueryBird] Connection failed: %v", ClassifyError(err))
		return nil, ClassifyError(err)
	}
	if err := conn.Ping(ctx); err != nil {
		conn.Close(ctx)
		log.Printf("[QueryBird] Ping failed: %v", ClassifyError(err))
		return nil, ClassifyError(err)
	}

	if s.Conn != nil {
		s.Conn.Close(ctx)
	}
	s.Conn = conn
	s.Cfg = &cfg

	log.Printf("[QueryBird] Connected to %s:%d/%s", cfg.Host, cfg.Port, cfg.Database)
	return &models.ConnectionState{
		Host:     cfg.Host,
		Port:     cfg.Port,
		Database: cfg.Database,
		Username: cfg.Username,
	}, nil
}

// MarkDisconnected closes and nilifies the connection so subsequent IsConnected
// checks return false. Called by the App layer when a mid-session DB error is
// detected (e.g. tunnel teardown).
func (s *Service) MarkDisconnected() {
	if s.Conn != nil {
		log.Printf("[QueryBird] Connection marked as disconnected")
		_ = s.Conn.Close(context.Background())
		s.Conn = nil
	}
}

func (s *Service) Close(ctx context.Context) {
	if s.Conn != nil {
		log.Printf("[QueryBird] Disconnecting from %s:%d/%s", s.Cfg.Host, s.Cfg.Port, s.Cfg.Database)
		s.Conn.Close(ctx)
		s.Conn = nil
	}
}

func (s *Service) openConn(ctx context.Context, cfg models.ConnectionConfig) (*pgx.Conn, error) {
	if cfg.Host == "" {
		cfg.Host = "localhost"
	}
	if cfg.Port == 0 {
		cfg.Port = 5432
	}
	if cfg.Database == "" {
		cfg.Database = "postgres"
	}
	if cfg.Username == "" {
		cfg.Username = "postgres"
	}
	if cfg.SSLMode == "" {
		// Default to "disable" — matches pgAdmin's default behaviour and works
		// reliably with port-forwarded / kubectl-tunnelled PostgreSQL instances
		// where sslmode=prefer or sslmode=require can cause the port-forward
		// process to crash (TLS ClientHello rejected by the tunnel layer).
		// Users who need TLS can select "require" or "verify-full" explicitly.
		cfg.SSLMode = "disable"
	}

	connString := buildConnectionString(cfg)
	config, err := pgx.ParseConfig(connString)
	if err != nil {
		return nil, err
	}
	config.RuntimeParams["application_name"] = "QueryBird"

	// Only configure TLS when the user has explicitly requested an SSL mode.
	// Skip certificate verification for "prefer"/"require" — port-forwarded and
	// tunnelled connections use self-signed / internal certs. We care about
	// encryption in-flight, not cert authority validation.
	if cfg.SSLMode == "prefer" || cfg.SSLMode == "require" {
		config.TLSConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 — intentional for port-forward/internal use
	}

	// Enable TCP keepalives so the OS detects and recovers dropped connections
	// (e.g. kubectl port-forward tunnels that go idle). Keepalive probes start
	// after 30 s of idle, sent every 10 s.
	// Timeout is raised to 30 s to accommodate slow port-forward handshakes —
	// kubectl tunnel setup can take several seconds on congested networks.
	config.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		d := &net.Dialer{
			KeepAlive: 30 * time.Second,
			Timeout:   30 * time.Second,
		}
		return d.DialContext(ctx, network, addr)
	}

	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

func buildConnectionString(cfg models.ConnectionConfig) string {
	q := url.URL{
		Scheme: "postgresql",
		Host:   netHost(cfg.Host, cfg.Port),
		Path:   "/" + cfg.Database,
	}
	query := url.Values{}
	query.Set("sslmode", cfg.SSLMode)
	q.RawQuery = query.Encode()
	q.User = url.UserPassword(cfg.Username, cfg.Password)
	return q.String()
}

func netHost(host string, port int) string {
	return host + ":" + strconv.Itoa(port)
}

func (s *Service) CurrentDatabase() string {
	if s.Cfg == nil {
		return ""
	}
	return s.Cfg.Database
}

// ClassifyError converts raw network/PostgreSQL errors into concise, user-friendly
// messages. The original error detail is written to the log but not shown in the UI
// so that credentials and internal hostnames are never exposed.
func ClassifyError(err error) error {
	if err == nil {
		return nil
	}

	msg := err.Error()
	lower := strings.ToLower(msg)

	// Context / timeout
	if errors.Is(err, context.DeadlineExceeded) ||
		strings.Contains(lower, "timeout") ||
		strings.Contains(lower, "i/o timeout") ||
		strings.Contains(lower, "deadline exceeded") {
		return fmt.Errorf("Connection timed out. Check the host, port, and network path.")
	}
	if errors.Is(err, context.Canceled) || strings.Contains(lower, "context canceled") {
		return fmt.Errorf("Connection attempt was cancelled.")
	}

	// Network-level
	if strings.Contains(lower, "connection reset by peer") || strings.Contains(lower, "connection reset") {
		return fmt.Errorf("Connection lost. Check your port-forward or tunnel and reconnect.")
	}
	if strings.Contains(lower, "connection refused") {
		return fmt.Errorf("Connection refused. PostgreSQL may not be running on that host/port.")
	}
	if strings.Contains(lower, "no such host") || strings.Contains(lower, "name resolution") || strings.Contains(lower, "no route to host") {
		return fmt.Errorf("Host not found. Check the hostname and network settings.")
	}
	if strings.Contains(lower, "eof") || strings.Contains(lower, "unexpected eof") || strings.Contains(lower, "broken pipe") || strings.Contains(lower, "lost connection") {
		return fmt.Errorf("Connection lost unexpectedly. Check your port-forward or tunnel and reconnect.")
	}
	if strings.Contains(lower, "network is unreachable") || strings.Contains(lower, "host unreachable") {
		return fmt.Errorf("Network unreachable. Check your VPN, tunnel, or network connection.")
	}

	// PostgreSQL authentication / SSL
	if strings.Contains(lower, "password authentication failed") || strings.Contains(lower, "authentication failed") {
		return fmt.Errorf("Authentication failed. Check your username and password.")
	}
	if strings.Contains(lower, "ssl") || strings.Contains(lower, "tls") {
		return fmt.Errorf("SSL/TLS error. Try changing the SSL mode in the connection settings.")
	}
	if strings.Contains(lower, "database") && strings.Contains(lower, "does not exist") {
		return fmt.Errorf("Database not found. Check the database name.")
	}
	if strings.Contains(lower, "role") && strings.Contains(lower, "does not exist") {
		return fmt.Errorf("User role not found. Check the username.")
	}

	// Generic fallback — return the raw message but strip any credential fragments
	return fmt.Errorf("%s", sanitizeErrorMessage(msg))
}

// sanitizeErrorMessage strips password-like segments from error strings before
// they are shown in the UI.
func sanitizeErrorMessage(msg string) string {
	// pgx embeds the DSN in some error messages; strip the password field.
	// Pattern: "password=<value>" or "PGPASSWORD=<value>"
	for _, prefix := range []string{"password=", "PGPASSWORD="} {
		if idx := strings.Index(strings.ToLower(msg), strings.ToLower(prefix)); idx >= 0 {
			end := idx + len(prefix)
			for end < len(msg) && msg[end] != ' ' && msg[end] != '&' && msg[end] != ';' {
				end++
			}
			msg = msg[:idx] + "[redacted]" + msg[end:]
		}
	}
	return msg
}
