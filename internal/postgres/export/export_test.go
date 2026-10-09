package export

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestFormatCSVValue(t *testing.T) {
	now := time.Now()
	testCases := []struct {
		input    any
		expected string
	}{
		{nil, ""},
		{123, "123"},
		{"hello", "hello"},
		{[]byte("world"), "world"},
		{true, "true"},
		{now, now.Format(time.RFC3339Nano)},
		{[16]byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16}, "01020304-0506-0708-0910-111213141516"},
	}

	for _, tc := range testCases {
		t.Run(fmt.Sprintf("%v", tc.input), func(t *testing.T) {
			got := formatCSVValue(tc.input)
			if got != tc.expected {
				t.Errorf("formatCSVValue(%v) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestFormatSQLValue(t *testing.T) {
	testCases := []struct {
		name     string
		input    any
		expected string
	}{
		{"nil", nil, "NULL"},
		{"bool-true", true, "true"},
		{"bool-false", false, "false"},
		{"int", 42, "42"},
		{"float", 3.14, "3.14"},
		{"string", "O'Reilly", "'O''Reilly'"},
		{"bytea", []byte("hello"), "decode('68656c6c6f', 'hex')"},
		{"uuid", [16]byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16}, "'01020304-0506-0708-0910-111213141516'"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got := formatSQLValue(tc.input)
			if got != tc.expected {
				t.Errorf("formatSQLValue(%v) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestFormatSQLTimeValue(t *testing.T) {
	utcLocation, err := time.LoadLocation("UTC")
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2023, 10, 24, 15, 30, 0, 123456000, utcLocation)
	got := formatSQLValue(ts)
	expected := "'2023-10-24 15:30:00.123456+00:00'"
	if !strings.HasPrefix(got, "'2023-10-24 15:30:00.123456") {
		t.Errorf("formatSQLValue(Time) = %q, want prefix %q", got, expected)
	}
}
