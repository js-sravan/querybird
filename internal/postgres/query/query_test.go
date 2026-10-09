package query

import (
	"strings"
	"testing"
)

func TestCheckDestructiveQuerySafety(t *testing.T) {
	testCases := []struct {
		name        string
		sql         string
		shouldError bool
		errContains string
	}{
		{
			name:        "Safe SELECT query",
			sql:         "SELECT * FROM users",
			shouldError: false,
		},
		{
			name:        "Safe UPDATE query with WHERE",
			sql:         "UPDATE users SET name = 'Bob' WHERE id = 1",
			shouldError: false,
		},
		{
			name:        "Safe DELETE query with WHERE",
			sql:         "DELETE FROM users WHERE id = 1",
			shouldError: false,
		},
		{
			name:        "Unsafe UPDATE query without WHERE",
			sql:         "UPDATE users SET name = 'Bob'",
			shouldError: true,
			errContains: "safety warning: UPDATE query has no WHERE clause",
		},
		{
			name:        "Unsafe DELETE query without WHERE",
			sql:         "DELETE FROM users",
			shouldError: true,
			errContains: "safety warning: DELETE query has no WHERE clause",
		},
		{
			name:        "Unsafe multi-statement query with one bad UPDATE",
			sql:         "SELECT * FROM logs; UPDATE users SET active = false; SELECT 1;",
			shouldError: true,
			errContains: "safety warning: UPDATE query has no WHERE clause",
		},
		{
			name:        "Bypassed unsafe UPDATE with comment bypass",
			sql:         "UPDATE users SET active = false; -- safety-bypass",
			shouldError: false,
		},
		{
			name:        "Bypassed unsafe DELETE with force comment",
			sql:         "DELETE FROM temp_table; -- force",
			shouldError: false,
		},
		{
			name:        "UPDATE with WHERE in uppercase",
			sql:         "UPDATE USERS SET ACTIVE = TRUE WHERE ID > 100",
			shouldError: false,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkDestructiveQuerySafety(tc.sql)
			if tc.shouldError {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				if !strings.Contains(err.Error(), tc.errContains) {
					t.Errorf("expected error to contain %q, got: %q", tc.errContains, err.Error())
				}
			} else {
				if err != nil {
					t.Fatalf("expected no error, got: %v", err)
				}
			}
		})
	}
}
