package lan

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Phone 配对过的手机。
type Phone struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Key      []byte    `json:"key"` // 配对密钥（JSON 里是 base64）
	PairedAt time.Time `json:"pairedAt"`
	LastSeen time.Time `json:"lastSeen,omitempty"`
}

// PhoneInfo 给界面看的信息（不含密钥）。
type PhoneInfo struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	PairedAt time.Time `json:"pairedAt"`
	LastSeen time.Time `json:"lastSeen,omitempty"`
}

// Store 电脑身份和配对过的手机，保存在用户配置目录（仅当前用户可读）。
type Store struct {
	mu     sync.Mutex
	path   string
	pcID   string
	mid    string
	phones map[string]*Phone
}

type storeFile struct {
	PCID   string   `json:"pcId"`
	Phones []*Phone `json:"phones"`
}

// OpenStore 读取（或新建）状态文件；dir 为空时只保存在内存里。
func OpenStore(dir string) *Store {
	s := &Store{phones: map[string]*Phone{}, mid: MachineID()}
	readOnly := false
	if dir != "" {
		s.path = filepath.Join(dir, "lan.json")
		b, err := os.ReadFile(s.path)
		if err != nil && !os.IsNotExist(err) {
			// 文件在但暂时读不了（被占用等）：不要用新标识覆盖它
			readOnly = true
		}
		if err == nil {
			var f storeFile
			if json.Unmarshal(b, &f) == nil {
				s.pcID = f.PCID
				for _, p := range f.Phones {
					if p.ID != "" && len(p.Key) == 32 {
						s.phones[p.ID] = p
					}
				}
			}
		}
	}
	if s.pcID == "" {
		// 优先用本机标识派生，lan.json 换了位置或丢了也能得到同一个 pcId；取不到才随机
		if s.pcID = derivedPCID(); s.pcID == "" {
			s.pcID = hex.EncodeToString(Random(rand.Reader, 8))
		}
		if !readOnly {
			s.save()
		}
	}
	return s
}

// MachineID 机器指纹（见 machine.go），取不到时为空。
func (s *Store) MachineID() string { return s.mid }

func (s *Store) save() {
	if s.path == "" {
		return
	}
	f := storeFile{PCID: s.pcID}
	for _, p := range s.phones {
		f.Phones = append(f.Phones, p)
	}
	b, _ := json.MarshalIndent(f, "", "  ")
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err == nil {
		tmp := s.path + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, s.path)
		}
	}
}

// PCID 这台电脑的标识。
func (s *Store) PCID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pcID
}

// Key 查手机的配对密钥。
func (s *Store) Key(phoneID string) ([]byte, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.phones[phoneID]
	if !ok {
		return nil, "", false
	}
	return p.Key, p.Name, true
}

// Add 保存（或替换）一台手机的配对密钥。
func (s *Store) Add(id, name string, key []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.phones[id] = &Phone{ID: id, Name: name, Key: key, PairedAt: time.Now()}
	s.save()
}

// Remove 取消配对。
func (s *Store) Remove(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.phones[id]; !ok {
		return false
	}
	delete(s.phones, id)
	s.save()
	return true
}

// Touch 记录最近连接时间。
func (s *Store) Touch(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.phones[id]; ok {
		p.LastSeen = time.Now()
		s.save()
	}
}

// List 配对过的手机（按最近连接排序）。
func (s *Store) List() []PhoneInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]PhoneInfo, 0, len(s.phones))
	for _, p := range s.phones {
		out = append(out, PhoneInfo{ID: p.ID, Name: p.Name, PairedAt: p.PairedAt, LastSeen: p.LastSeen})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

// 虚拟网卡（虚拟机、WSL、VPN 等），手机一般连不到，排在后面
var virtualIface = []string{"vmware", "virtualbox", "vbox", "vethernet", "hyper-v", "wsl", "docker", "loopback", "tailscale", "zerotier", "utun", "tun", "tap", "npcap", "bluetooth", "蓝牙"}

// tailscaleNet Tailscale（以及 Headscale 等兼容实现）给设备分配的地址段，即运营商级 NAT 地址段 100.64.0.0/10
var tailscaleNet = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// IsTailscale 是不是 Tailscale 虚拟局域网的地址：手机也登录同一个 Tailscale 账号时，不在同一个 WiFi 也能用它连接
func IsTailscale(ip string) bool {
	p := net.ParseIP(ip)
	return p != nil && p.To4() != nil && tailscaleNet.Contains(p)
}

// 网卡地址缓存：Windows 上枚举一次要 80～400 毫秒（每块网卡取地址都会把所有网卡重新查一遍，装了 VMware 等虚拟网卡更慢），
// 状态接口每秒调一次，推流占着 CPU 时会超过电脑端界面的超时，界面就显示「连不上服务」。
// 第一次同步取；之后超过 addrTTL 就返回旧值并在后台刷新
const addrTTL = 5 * time.Second

var addrCache struct {
	sync.Mutex
	list       []string
	at         time.Time
	refreshing bool
}

// Addrs 本机局域网 IPv4 地址，真实网卡在前（最多晚 addrTTL 反映网卡变化）。
func Addrs() []string {
	c := &addrCache
	c.Lock()
	defer c.Unlock()
	if c.at.IsZero() {
		c.list, c.at = scanAddrs(), time.Now()
	} else if time.Since(c.at) > addrTTL && !c.refreshing {
		c.refreshing = true
		go func() {
			l := scanAddrs()
			c.Lock()
			c.list, c.at, c.refreshing = l, time.Now(), false
			c.Unlock()
		}()
	}
	return append([]string(nil), c.list...)
}

func scanAddrs() []string {
	type cand struct {
		ip      string
		virtual bool
	}
	var list []cand
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(ifc.Name)
		virtual := false
		for _, v := range virtualIface {
			if strings.Contains(name, v) {
				virtual = true
			}
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipn.IP.To4()
			if ip4 == nil || ip4.IsLinkLocalUnicast() || ip4.IsLoopback() {
				continue
			}
			list = append(list, cand{ip4.String(), virtual || !ip4.IsPrivate()})
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return !list[i].virtual && list[j].virtual })
	out := make([]string, 0, len(list))
	for _, c := range list {
		out = append(out, c.ip)
	}
	return out
}
