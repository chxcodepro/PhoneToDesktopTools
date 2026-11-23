package lan

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func fakeMachine(t *testing.T, seed, host string) {
	t.Helper()
	oldSeed, oldHost := machineSeed, hostName
	machineSeed = func() string { return seed }
	hostName = func() string { return host }
	t.Cleanup(func() { machineSeed, hostName = oldSeed, oldHost })
}

var hexID = regexp.MustCompile(`^[0-9a-f]{16}$`)

// lan.json 换了位置（比如从 MSIX 程序里启动被重定向）或丢失：同一台电脑应得到同一个 pcId
func TestPCIDStableAcrossStoreLocations(t *testing.T) {
	fakeMachine(t, "4c4c4544-0042-3510-8051-b4c04f4e3732", "PC-20260913SNBR")
	a := OpenStore(t.TempDir())
	b := OpenStore(t.TempDir())
	if a.PCID() != b.PCID() {
		t.Fatalf("不同存储位置得到了不同的 pcId：%s / %s", a.PCID(), b.PCID())
	}
	if !hexID.MatchString(a.PCID()) {
		t.Fatalf("pcId 格式应与旧版相同（16 位十六进制）：%q", a.PCID())
	}
	if a.MachineID() == "" || a.MachineID() != b.MachineID() || a.MachineID() == a.PCID() {
		t.Fatalf("机器指纹应稳定且与 pcId 不同：%q / %q", a.MachineID(), b.MachineID())
	}
	if OpenStore("").PCID() != a.PCID() {
		t.Fatal("内存模式也应派生同一个 pcId")
	}
}

// 已有的 pcId（旧版随机生成的）保持不变，否则手机上按 pcId 保存的配对密钥会失效
func TestExistingPCIDKept(t *testing.T) {
	fakeMachine(t, "guid-1", "host")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "lan.json"), []byte(`{"pcId":"47b2c8fc24753411","phones":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(dir)
	if s.PCID() != "47b2c8fc24753411" {
		t.Fatalf("已有 pcId 被改了：%s", s.PCID())
	}
	if s.MachineID() != OpenStore(t.TempDir()).MachineID() {
		t.Fatal("机器指纹不应依赖 lan.json")
	}
}

func TestDerivedIDsDistinguishMachines(t *testing.T) {
	fakeMachine(t, "guid-1", "host-a")
	a, ma := derivedPCID(), MachineID()
	fakeMachine(t, "guid-1", "HOST-A ") // 大小写、空白不影响
	if derivedPCID() != a || MachineID() != ma {
		t.Fatal("主机名大小写不应改变标识")
	}
	fakeMachine(t, "guid-1", "host-b") // Ghost 克隆：MachineGuid 相同、主机名不同
	if derivedPCID() == a || MachineID() == ma {
		t.Fatal("主机名不同应得到不同标识")
	}
	fakeMachine(t, "guid-2", "host-a")
	if derivedPCID() == a {
		t.Fatal("系统标识不同应得到不同标识")
	}
}

// 取不到系统标识：退回随机 pcId，不给机器指纹
func TestNoMachineSeedFallsBackToRandom(t *testing.T) {
	fakeMachine(t, "", "host")
	a, b := OpenStore(t.TempDir()), OpenStore(t.TempDir())
	if a.PCID() == b.PCID() || !hexID.MatchString(a.PCID()) {
		t.Fatalf("应生成随机 pcId：%s / %s", a.PCID(), b.PCID())
	}
	if a.MachineID() != "" {
		t.Fatal("没有系统标识时不应给机器指纹")
	}
}

// 本机真实读取（Windows 读注册表、Linux 读 machine-id）：只检查不报错且稳定
func TestSystemMachineID(t *testing.T) {
	if systemMachineID() != systemMachineID() {
		t.Fatal("系统标识应稳定")
	}
	t.Logf("本机系统标识可用：%v", systemMachineID() != "")
}
