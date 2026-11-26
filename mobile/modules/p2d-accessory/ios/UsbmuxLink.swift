import Foundation
import Darwin

// iPhone 数据线连接：iOS 没有给 App 用的 USB 接口，电脑经系统的 usbmuxd 把一条 TCP 连接接到 iPhone 本机的
// PIPE_PORT 端口（App 在回环地址上监听）。这条连接就是「管道」，上面跑和安卓免调试连接（AccessoryLink.kt）
// 完全相同的多路复用协议：App 本机再监听一个回环端口，每条 TCP 连接对应管道上的一个流，电脑端把流接到它的服务端口，
// 效果和 adb reverse 隧道一样，JS 照旧用 ws://127.0.0.1:<端口>/mcp?token=… 连接。
// 帧格式、流量控制和电脑端 desktop/core/internal/aoa（frame.go、link.go）、internal/iphone 一致，改动时几处一起改。
//
// 用 BSD 套接字 + 线程实现，和 Kotlin 版的结构一一对应；阻塞调用前都先 poll（1 秒超时），关闭时线程能及时退出。

private let MAGIC: UInt8 = 0xA5
private let HEADER = 8
private let T_HELLO: UInt8 = 1
private let T_CONFIG: UInt8 = 2
private let T_PONG: UInt8 = 3
private let T_OPEN: UInt8 = 4
private let T_DATA: UInt8 = 5
private let T_CLOSE: UInt8 = 6
private let T_ACK: UInt8 = 7
private let MAX_PAYLOAD = 8192
private let MAX_WRITE = 15000
private let READ_BUF = 16384
private let WINDOW = 256 * 1024
private let ACK_EVERY = 64 * 1024
private let PONG_TIMEOUT: TimeInterval = 6

private func frame(_ type: UInt8, _ id: UInt32, _ payload: ArraySlice<UInt8> = []) -> [UInt8] {
  var b = [UInt8]()
  b.reserveCapacity(HEADER + payload.count)
  b.append(MAGIC)
  b.append(type)
  b.append(UInt8((id >> 24) & 0xFF))
  b.append(UInt8((id >> 16) & 0xFF))
  b.append(UInt8((id >> 8) & 0xFF))
  b.append(UInt8(id & 0xFF))
  let n = UInt16(payload.count)
  b.append(UInt8(n >> 8))
  b.append(UInt8(n & 0xFF))
  b.append(contentsOf: payload)
  return b
}

private func ackPayload(_ n: Int) -> ArraySlice<UInt8> {
  let v = UInt32(n)
  return [UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)][...]
}

private func spawn(_ name: String, _ body: @escaping () -> Void) {
  let t = Thread(block: body)
  t.name = name
  t.start()
}

/// 套接字小工具
enum Sock {
  /// 在 127.0.0.1:port 上监听；port 为 0 时由系统选端口。失败返回 -1
  static func listen(port: UInt16) -> Int32 {
    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return -1 }
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    if r != 0 || Darwin.listen(fd, 16) != 0 {
      Darwin.close(fd)
      return -1
    }
    return fd
  }

  static func localPort(_ fd: Int32) -> Int {
    var addr = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let r = withUnsafeMutablePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    return r == 0 ? Int(UInt16(bigEndian: addr.sin_port)) : 0
  }

  /// 等 fd 可读（或出错 / 对方关闭），最多 ms 毫秒；可读返回 true
  static func waitReadable(_ fd: Int32, _ ms: Int32) -> Bool {
    var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    return Darwin.poll(&p, 1, ms) > 0
  }

  /// 有新连接时接受（等 1 秒），没有返回 -1、出错返回 -2
  static func accept(_ fd: Int32) -> Int32 {
    if !waitReadable(fd, 1000) { return -1 }
    let c = Darwin.accept(fd, nil, nil)
    if c < 0 { return errno == EINTR || errno == EAGAIN || errno == ECONNABORTED ? -1 : -2 }
    var on: Int32 = 1
    _ = setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    _ = setsockopt(c, Int32(IPPROTO_TCP), TCP_NODELAY, &on, socklen_t(MemoryLayout<Int32>.size))
    return c
  }

  /// 读一次：返回读到的字节数；超时（1 秒没数据）返回 0；对方关闭或出错返回 -1
  static func read(_ fd: Int32, _ buf: inout [UInt8]) -> Int {
    if !waitReadable(fd, 1000) { return 0 }
    let n = buf.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
    if n > 0 { return n }
    if n < 0 && (errno == EINTR || errno == EAGAIN) { return 0 }
    return -1
  }

  static func writeAll(_ fd: Int32, _ data: [UInt8]) -> Bool {
    var off = 0
    while off < data.count {
      let n = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + off, data.count - off) }
      if n < 0 {
        if errno == EINTR || errno == EAGAIN { continue }
        return false
      }
      off += n
    }
    return true
  }
}

/// 管道监听和当前链路（全局只有一个）
final class UsbmuxLink {
  static let shared = UsbmuxLink()
  /// 电脑经 usbmuxd 连接的端口，和电脑端 internal/iphone.PhonePort 一致
  static let pipePort: UInt16 = 39274
  /// 本机给 JS 连接的端口：固定一个，App 重开后 JS 用保存的参数也能重连；被占用时随机选
  static let preferredPort: UInt16 = 39273

  private let lock = NSLock()
  private var listenFd: Int32 = -1
  private var generation = 0
  private var session: Session?

  /// 电脑发来的最新连接链接（p2d://connect?…），JS 启动后取走
  var pendingUrl: String?
  /// JS 已加载时由模块设置，收到连接参数立即通知
  var listener: ((String) -> Void)?
  var appVersion = ""
  var deviceName = "iPhone"

  /// 开始（或重新开始）监听管道端口。App 回到前台时也调用：iOS 挂起 App 期间监听的套接字可能已失效
  func start() {
    lock.lock()
    generation += 1
    let gen = generation
    if listenFd >= 0 { Darwin.close(listenFd) }
    listenFd = Sock.listen(port: UsbmuxLink.pipePort)
    let fd = listenFd
    lock.unlock()
    if fd < 0 {
      NSLog("[P2dAccessory] 监听端口 %d 失败", Int(UsbmuxLink.pipePort))
      return
    }
    spawn("p2d-usbmux-listen") { [weak self] in self?.acceptLoop(fd: fd, gen: gen) }
  }

  func isOpen() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return session?.alive == true
  }

  private func acceptLoop(fd: Int32, gen: Int) {
    while true {
      lock.lock()
      let current = generation == gen
      lock.unlock()
      if !current { return }
      let c = Sock.accept(fd)
      if c == -1 { continue }
      if c < 0 {
        // 监听失效（App 被挂起后恢复等）：重新监听
        lock.lock()
        let still = generation == gen
        lock.unlock()
        if still { DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in self?.start() } }
        return
      }
      // 电脑连上来了（第一次，或电脑端重连）：换成新的链路
      let s = Session(pipe: c, link: self)
      lock.lock()
      let old = session
      session = s
      lock.unlock()
      old?.close("电脑端重新连接")
      s.start()
      NSLog("[P2dAccessory] 电脑已经数据线连接，等待握手")
    }
  }

  func lost(_ s: Session, _ reason: String) {
    s.close(reason)
    lock.lock()
    if session === s { session = nil }
    lock.unlock()
  }

  func deliver(_ url: String) {
    lock.lock()
    pendingUrl = url
    let l = listener
    lock.unlock()
    l?(url)
  }

  func takePending() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let u = pendingUrl
    pendingUrl = nil
    return u
  }
}

/// 一次电脑连接的链路
final class Session {
  private let pipe: Int32
  private weak var link: UsbmuxLink?
  private let lock = NSCondition()
  private var out: [[UInt8]] = []
  private var streams: [UInt32: Stream] = [:]
  private var nextId: UInt32 = 1
  private var server: Int32 = -1
  private var configured = false
  private var lastPong = Date()
  private(set) var alive = true
  private let nonce: String = (0..<8).map { _ in String(format: "%02x", Int.random(in: 0...255)) }.joined()

  init(pipe: Int32, link: UsbmuxLink) {
    self.pipe = pipe
    self.link = link
  }

  func start() {
    server = Sock.listen(port: UsbmuxLink.preferredPort)
    if server < 0 { server = Sock.listen(port: 0) }
    spawn("p2d-usbmux-read") { [weak self] in self?.readLoop() }
    spawn("p2d-usbmux-write") { [weak self] in self?.writeLoop() }
    spawn("p2d-usbmux-accept") { [weak self] in self?.acceptLoop() }
    spawn("p2d-usbmux-hello") { [weak self] in self?.helloLoop() }
  }

  func send(_ f: [UInt8]) {
    lock.lock()
    if alive {
      out.append(f)
      lock.signal()
    }
    lock.unlock()
  }

  func close(_ reason: String) {
    lock.lock()
    if !alive {
      lock.unlock()
      return
    }
    alive = false
    let all = Array(streams.values)
    streams.removeAll()
    lock.broadcast()
    lock.unlock()
    NSLog("[P2dAccessory] 链路关闭：%@", reason)
    all.forEach { $0.abort() }
    if server >= 0 { Darwin.close(server) }
    Darwin.close(pipe)
  }

  func remove(_ s: Stream) {
    lock.lock()
    if streams[s.id] === s { streams.removeValue(forKey: s.id) }
    lock.unlock()
  }

  private func isAlive() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return alive
  }

  /// 每秒发一次握手（也是心跳）；电脑这么久没回应，说明电脑端退出了：作废所有流，等它重新回应
  private func helloLoop() {
    while isAlive() {
      let name = link?.deviceName ?? "iPhone"
      let hello: [String: Any] = ["v": 1, "nonce": nonce, "name": name, "app": link?.appVersion ?? ""]
      if let data = try? JSONSerialization.data(withJSONObject: hello) {
        lock.lock()
        let backlog = out.count
        lock.unlock()
        if backlog < 64 { send(frame(T_HELLO, 0, [UInt8](data)[...])) }
      }
      lock.lock()
      let stale = configured && Date().timeIntervalSince(lastPong) > PONG_TIMEOUT
      var dropped: [Stream] = []
      if stale {
        configured = false
        dropped = Array(streams.values)
        streams.removeAll()
      }
      lock.unlock()
      if stale {
        NSLog("[P2dAccessory] 电脑端没有回应，等待重新握手")
        dropped.forEach { $0.abort() }
      }
      Thread.sleep(forTimeInterval: 1)
    }
  }

  private func readLoop() {
    var buf = [UInt8](repeating: 0, count: READ_BUF)
    var pending = [UInt8]()
    while isAlive() {
      let n = Sock.read(pipe, &buf)
      if n < 0 {
        link?.lost(self, "电脑端断开或数据线已拔出")
        return
      }
      if n == 0 { continue }
      lock.lock()
      lastPong = Date()
      lock.unlock()
      pending.append(contentsOf: buf[0..<n])
      var pos = 0
      while pending.count - pos >= HEADER {
        if pending[pos] != MAGIC { // 格式不对（电脑端中途重启留下的半帧）：丢弃
          pos = pending.count
          break
        }
        let type = pending[pos + 1]
        let id = UInt32(pending[pos + 2]) << 24 | UInt32(pending[pos + 3]) << 16 | UInt32(pending[pos + 4]) << 8 | UInt32(pending[pos + 5])
        let len = Int(pending[pos + 6]) << 8 | Int(pending[pos + 7])
        if len > MAX_PAYLOAD {
          pos = pending.count
          break
        }
        if pending.count - pos < HEADER + len { break }
        handle(type, id, Array(pending[(pos + HEADER)..<(pos + HEADER + len)]))
        pos += HEADER + len
      }
      pending = pos >= pending.count ? [] : Array(pending[pos...])
    }
  }

  private func stream(_ id: UInt32) -> Stream? {
    lock.lock()
    defer { lock.unlock() }
    return streams[id]
  }

  private func handle(_ type: UInt8, _ id: UInt32, _ payload: [UInt8]) {
    switch type {
    case T_CONFIG:
      guard let obj = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any] else { return }
      if (obj["nonce"] as? String) != nonce { return }
      lock.lock()
      configured = true
      lock.unlock()
      let port = server >= 0 ? Sock.localPort(server) : 0
      if port == 0 { return }
      var c = URLComponents()
      c.scheme = "p2d"
      c.host = "connect"
      var q = [
        URLQueryItem(name: "token", value: obj["token"] as? String ?? ""),
        URLQueryItem(name: "host", value: obj["host"] as? String ?? ""),
        URLQueryItem(name: "os", value: obj["os"] as? String ?? ""),
        URLQueryItem(name: "port", value: String(port)),
      ]
      if let pcid = obj["pcid"] as? String, !pcid.isEmpty { q.append(URLQueryItem(name: "pcid", value: pcid)) }
      c.queryItems = q
      if let url = c.string {
        NSLog("[P2dAccessory] 收到电脑端的连接参数")
        link?.deliver(url)
      }
    case T_PONG:
      break
    case T_DATA:
      stream(id)?.push(payload)
    case T_CLOSE:
      stream(id)?.remoteClose()
    case T_ACK:
      if payload.count == 4 {
        let n = Int(payload[0]) << 24 | Int(payload[1]) << 16 | Int(payload[2]) << 8 | Int(payload[3])
        stream(id)?.grant(n)
      }
    default:
      break
    }
  }

  /// 把待发的帧攒成不超过 MAX_WRITE 的一批写出
  private func writeLoop() {
    while true {
      lock.lock()
      while out.isEmpty && alive { _ = lock.wait(until: Date().addingTimeInterval(1)) }
      if !alive {
        lock.unlock()
        return
      }
      var batch = [UInt8]()
      batch.reserveCapacity(MAX_WRITE)
      while let f = out.first, batch.isEmpty || batch.count + f.count <= MAX_WRITE {
        batch.append(contentsOf: f)
        out.removeFirst()
      }
      lock.unlock()
      if !Sock.writeAll(pipe, batch) {
        link?.lost(self, "写入失败，数据线可能已拔出")
        return
      }
    }
  }

  private func acceptLoop() {
    while isAlive() {
      if server < 0 { return }
      let c = Sock.accept(server)
      if c == -1 { continue }
      if c < 0 { return }
      lock.lock()
      let ok = configured && alive
      var s: Stream?
      if ok {
        let id = nextId
        nextId += 1
        let st = Stream(id: id, fd: c, session: self)
        streams[id] = st
        s = st
      }
      lock.unlock()
      guard let st = s else {
        Darwin.close(c) // 还没拿到电脑的连接参数：拒绝
        continue
      }
      send(frame(T_OPEN, st.id))
      st.start()
    }
  }
}

/// 手机上的一条 TCP 连接 ↔ 管道上的一个流
final class Stream {
  let id: UInt32
  private let fd: Int32
  private weak var session: Session?
  private let cond = NSCondition()
  private var queue: [[UInt8]] = []
  private var sendWin = WINDOW
  private var remoteClosed = false
  private var closed = false

  init(id: UInt32, fd: Int32, session: Session) {
    self.id = id
    self.fd = fd
    self.session = session
  }

  func start() {
    spawn("p2d-usbmux-s\(id)-in") { [weak self] in self?.fromSocket() }
    spawn("p2d-usbmux-s\(id)-out") { [weak self] in self?.toSocket() }
  }

  private func isClosed() -> Bool {
    cond.lock()
    defer { cond.unlock() }
    return closed
  }

  /// 本机（JS）→ 电脑
  private func fromSocket() {
    var buf = [UInt8](repeating: 0, count: MAX_PAYLOAD)
    while true {
      if isClosed() { return }
      let n = Sock.read(fd, &buf)
      if n == 0 { continue }
      if n < 0 {
        cond.lock()
        let tell = !closed && !remoteClosed
        cond.unlock()
        finish(tell)
        return
      }
      cond.lock()
      while sendWin < n && !closed { _ = cond.wait(until: Date().addingTimeInterval(1)) }
      if closed {
        cond.unlock()
        return
      }
      sendWin -= n
      cond.unlock()
      session?.send(frame(T_DATA, id, buf[0..<n]))
    }
  }

  /// 电脑 → 本机（JS）。写出后回 ACK，电脑才能继续发
  private func toSocket() {
    var unacked = 0
    while true {
      cond.lock()
      while queue.isEmpty && !remoteClosed && !closed { _ = cond.wait(until: Date().addingTimeInterval(1)) }
      if closed || queue.isEmpty {
        let wasClosed = closed
        cond.unlock()
        if unacked > 0 { session?.send(frame(T_ACK, id, ackPayload(unacked))) }
        if !wasClosed { finish(false) }
        return
      }
      let p = queue.removeFirst()
      let last = queue.isEmpty
      cond.unlock()
      if !Sock.writeAll(fd, p) {
        finish(true)
        return
      }
      unacked += p.count
      if unacked >= ACK_EVERY || last {
        session?.send(frame(T_ACK, id, ackPayload(unacked)))
        unacked = 0
      }
    }
  }

  func push(_ p: [UInt8]) {
    cond.lock()
    if !closed && !remoteClosed {
      queue.append(p)
      cond.broadcast()
    }
    cond.unlock()
  }

  func grant(_ n: Int) {
    cond.lock()
    sendWin += n
    cond.broadcast()
    cond.unlock()
  }

  func remoteClose() {
    cond.lock()
    remoteClosed = true
    cond.broadcast()
    cond.unlock()
  }

  /// 结束：tell=true 时告诉电脑这个流关了
  private func finish(_ tell: Bool) {
    if tell { session?.send(frame(T_CLOSE, id)) }
    abort()
    session?.remove(self)
  }

  func abort() {
    cond.lock()
    if closed {
      cond.unlock()
      return
    }
    closed = true
    queue.removeAll()
    cond.broadcast()
    cond.unlock()
    Darwin.close(fd)
  }
}
