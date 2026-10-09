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
	"github.com/jackc/pgx/v5/pgxpool"

	"dbclient/internal/models"
)

// connectTimeout caps the entire PostgreSQL handshake (TCP + auth + startup).
// Distinct from the dial timeout so slow TLS/auth stages are also bounded.
const connectTimeout = 30 * time.Second

type Service struct {
	Conn *pgxpool.Pool
	Cfg  *models.ConnectionConfig
}

func NewService() *Service {
	return &Service{}
}

// IsConnected returns true when the connection pool exists.
func (s *Service) IsConnected() bool {
	return s.Conn != nil
}

func (s *Service) TestConnection(ctx context.Context, cfg models.ConnectionConfig) error {
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := s.openSingleConn(ctx, cfg)
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
	log.Printf("[QueryBird] Connecting pool to %s:%d/%s as %s", cfg.Host, cfg.Port, cfg.Database, cfg.Username)

	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()

	pool, err := s.openPool(ctx, cfg)
	if err != nil {
		log.Printf("[QueryBird] Connection pool failed: %v", ClassifyError(err))
		return nil, ClassifyError(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		log.Printf("[QueryBird] Pool Ping failed: %v", ClassifyError(err))
		return nil, ClassifyError(err)
	}

	if s.Conn != nil {
		s.Conn.Close()
	}
	s.Conn = pool
	s.Cfg = &cfg

	log.Printf("[QueryBird] Connected connection pool to %s:%d/%s", cfg.Host, cfg.Port, cfg.Database)
	return &models.ConnectionState{
		Host:     cfg.Host,
		Port:     cfg.Port,
		Database: cfg.Database,
		Username: cfg.Username,
	}, nil
}

// MarkDisconnected closes and nilifies the connection pool.
func (s *Service) MarkDisconnected() {
	if s.Conn != nil {
		log.Printf("[QueryBird] Connection pool marked as disconnected")
		s.Conn.Close()
		s.Conn = nil
	}
}

func (s *Service) Close(ctx context.Context) {
	if s.Conn != nil {
		log.Printf("[QueryBird] Disconnecting pool from %s:%d/%s", s.Cfg.Host, s.Cfg.Port, s.Cfg.Database)
		s.Conn.Close()
		s.Conn = nil
	}
}

func (s *Service) openSingleConn(ctx context.Context, cfg models.ConnectionConfig) (*pgx.Conn, error) {
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
		cfg.SSLMode = "disable"
	}

	connString := buildConnectionString(cfg)
	config, err := pgx.ParseConfig(connString)
	if err != nil {
		return nil, err
	}
	config.RuntimeParams["application_name"] = "QueryBird"

	if cfg.SSLMode == "prefer" || cfg.SSLMode == "require" {
		config.TLSConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 — intentional for port-forward/internal use
	} else if cfg.SSLMode == "verify-full" || cfg.SSLMode == "verify-ca" {
		config.TLSConfig = &tls.Config{
			InsecureSkipVerify: false,
			ServerName:         cfg.Host,
		}
	}

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

func (s *Service) openPool(ctx context.Context, cfg models.ConnectionConfig) (*pgxpool.Pool, error) {
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
		cfg.SSLMode = "disable"
	}

	connString := buildConnectionString(cfg)
	config, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, err
	}
	config.ConnConfig.RuntimeParams["application_name"] = "QueryBird"

	if cfg.SSLMode == "prefer" || cfg.SSLMode == "require" {
		config.ConnConfig.TLSConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 — intentional for port-forward/internal use
	} else if cfg.SSLMode == "verify-full" || cfg.SSLMode == "verify-ca" {
		config.ConnConfig.TLSConfig = &tls.Config{
			InsecureSkipVerify: false,
			ServerName:         cfg.Host,
		}
	}

	config.ConnConfig.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		d := &net.Dialer{
			KeepAlive: 30 * time.Second,
			Timeout:   30 * time.Second,
		}
		return d.DialContext(ctx, network, addr)
	}

	// Set connection pool limits
	config.MaxConns = 10
	config.MinConns = 1

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	return pool, nil
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
	if strings.Contains(host, ":") { // IPv6
		return "[" + host + "]:" + strconv.Itoa(port)
	}
	return host + ":" + strconv.Itoa(port)
}

func ClassifyError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "connection reset by peer") {
		return errors.New("Connection lost. Check your port-forward or tunnel and reconnect.")
	}
	if strings.Contains(msg, "lookup") && strings.Contains(msg, "no such host") {
		return errors.New("Host not found. Check the hostname and network settings.")
	}
	if strings.Contains(msg, "connection refused") {
		return errors.New("Connection refused. PostgreSQL may not be running on that host/port.")
	}
	if strings.Contains(msg, "authentication failed") {
		return errors.New("Authentication failed. Check your username and password.")
	}
	if strings.Contains(msg, "deadline exceeded") || strings.Contains(msg, "timeout") {
		return errors.New("Connection timed out. Check the host, port, and network path.")
	}
	if strings.Contains(msg, "network is unreachable") || strings.Contains(msg, "unreachable") {
		return errors.New("Network unreachable. Check your VPN, tunnel, or network connection.")
	}
	if strings.Contains(msg, "EOF") || strings.Contains(msg, "broken pipe") {
		return errors.New("Connection lost unexpectedly. Check your port-forward or tunnel and reconnect.")
	}
	if strings.Contains(msg, "ssl") || strings.Contains(msg, "tls") || strings.Contains(msg, "certificate") {
		return fmt.Errorf("SSL/TLS error: %v. Try changing the SSL mode in the connection settings.", err)
	}
	return err
}
