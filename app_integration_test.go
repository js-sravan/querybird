package main

import (
	"context"
	"os"
	"strconv"
	"testing"

	"dbclient/internal/models"
)

func TestPostgresVerticalSlice(t *testing.T) {
	password, ok := os.LookupEnv("DBCLIENT_TEST_PASSWORD")
	if !ok {
		t.Skip("set DBCLIENT_TEST_PASSWORD to run the local PostgreSQL integration test")
	}

	port := 5432
	if rawPort := os.Getenv("DBCLIENT_TEST_PORT"); rawPort != "" {
		parsedPort, err := strconv.Atoi(rawPort)
		if err != nil {
			t.Fatalf("parse DBCLIENT_TEST_PORT: %v", err)
		}
		port = parsedPort
	}

	config := models.ConnectionConfig{
		Host:     envOrDefault("DBCLIENT_TEST_HOST", "localhost"),
		Port:     port,
		Database: envOrDefault("DBCLIENT_TEST_DATABASE", "mydb"),
		Username: envOrDefault("DBCLIENT_TEST_USERNAME", "postgres"),
		Password: password,
		SSLMode:  envOrDefault("DBCLIENT_TEST_SSLMODE", "prefer"),
	}

	app := NewApp()
	app.startup(context.Background())
	t.Cleanup(func() {
		if err := app.Disconnect(); err != nil {
			t.Errorf("disconnect: %v", err)
		}
	})

	state, err := app.Connect(config)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if state.Database != config.Database {
		t.Fatalf("connected database = %q, want %q", state.Database, config.Database)
	}

	databases, err := app.ListDatabases()
	if err != nil {
		t.Fatalf("list databases: %v", err)
	}
	if !contains(databases, config.Database) {
		t.Errorf("database list does not contain connected database %q", config.Database)
	}

	schemas, err := app.ListSchemas()
	if err != nil {
		t.Fatalf("list schemas: %v", err)
	}
	if len(schemas) == 0 {
		t.Fatal("expected at least one visible schema")
	}
	for _, schema := range schemas {
		if len(schema) >= 3 && schema[:3] == "pg_" {
			t.Errorf("system schema %q should not be shown in the explorer", schema)
		}
	}

	if _, err := app.ListObjects("public"); err != nil {
		t.Fatalf("list public schema objects: %v", err)
	}

	result, err := app.ExecuteQuery("SELECT current_database() AS database, current_user AS username")
	if err != nil {
		t.Fatalf("execute query: %v", err)
	}
	if result.RowCount != 1 || result.Rows[0]["database"] != config.Database {
		t.Fatalf("unexpected query result: %#v", result)
	}
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
