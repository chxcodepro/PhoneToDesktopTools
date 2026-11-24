package server

// 手机从电脑按块读取任意文件（含二进制），用于在两台电脑之间传文件（手机中转：从 A 读，再上传到 B）：
//   p2d/file.read { path, offset?, size? } → { data(base64), offset, size(文件总大小), eof }
// 每次最多读 1 MB；需要「读写文件」权限（读）。

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"p2d/core/internal/perm"
	"p2d/core/internal/tools"
)

const (
	fileReadDefault = 512 << 10
	fileReadMax     = 1 << 20
)

func (s *Session) fileRead(params json.RawMessage) (any, error) {
	var p struct {
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
		Size   int    `json:"size"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, fmt.Errorf("需要文件路径 path")
	}
	if ok, why := s.Info().Permissions.Allow(perm.CatFS, perm.Read); !ok {
		return nil, fmt.Errorf("%s", why)
	}
	if p.Offset < 0 {
		return nil, fmt.Errorf("offset 不能小于 0")
	}
	if p.Size <= 0 {
		p.Size = fileReadDefault
	}
	if p.Size > fileReadMax {
		p.Size = fileReadMax
	}
	path := tools.ResolvePath(p.Path)
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打不开文件：%v", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("读取文件信息失败：%v", err)
	}
	if st.IsDir() {
		return nil, fmt.Errorf("%s 是文件夹，不是文件", path)
	}
	buf := make([]byte, p.Size)
	n, err := f.ReadAt(buf, p.Offset)
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("读取失败：%v", err)
	}
	end := p.Offset + int64(n)
	return map[string]any{
		"path":   path,
		"data":   base64.StdEncoding.EncodeToString(buf[:n]),
		"offset": p.Offset,
		"size":   st.Size(),
		"eof":    end >= st.Size(),
	}, nil
}
