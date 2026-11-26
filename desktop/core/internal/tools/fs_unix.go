//go:build !windows

package tools

import (
	"io/fs"
	"strings"
)

func isHidden(dir, name string, info fs.FileInfo) bool {
	return strings.HasPrefix(name, ".")
}
