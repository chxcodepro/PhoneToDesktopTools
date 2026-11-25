package expo.modules.p2daccessory

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbAccessory
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 免调试连接（Android 配件模式）：电脑端把手机切换成配件后，双方经数据线的一对 bulk 端点收发字节。
 *
 * 手机本机监听一个回环端口，每条 TCP 连接对应管道上的一个「流」，电脑端把流接到它的服务端口，
 * 效果和 adb reverse 隧道一样：JS 照旧用 ws://127.0.0.1:<端口>/mcp?token=… 连接。
 * 帧格式、流量控制和电脑端 desktop/core/internal/aoa（frame.go、link.go）一致，改动时两边一起改。
 */
object AccessoryLink {
  const val TAG = "P2dAccessory"
  const val MANUFACTURER = "PhoneToDesktop"
  const val MODEL = "P2D"
  /** 本机监听端口：固定一个，App 重开后 JS 用保存的参数也能重连；被占用时随机选 */
  const val PREFERRED_PORT = 39273

  @Volatile private var session: Session? = null
  /** 电脑发来的最新连接链接（p2d://connect?…），JS 启动后取走 */
  @Volatile var pendingUrl: String? = null
  /** JS 已加载时由模块设置，收到连接参数立即通知 */
  @Volatile var listener: ((String) -> Unit)? = null
  @Volatile var appVersion: String = ""
  private var receiverRegistered = false

  fun isOurs(a: UsbAccessory): Boolean = a.manufacturer == MANUFACTURER && a.model == MODEL

  fun isOpen(): Boolean = session?.alive == true

  /** 打开配件：acc 为空时找系统里已插着、已授权的配件（App 冷启动、回到前台时） */
  @Synchronized
  fun attach(ctx: Context, acc: UsbAccessory?) {
    val app = ctx.applicationContext
    val um = app.getSystemService(Context.USB_SERVICE) as? UsbManager ?: return
    val a = acc ?: um.accessoryList?.firstOrNull { isOurs(it) } ?: return
    if (!isOurs(a) || !um.hasPermission(a)) return
    session?.let {
      // 回到前台时的检查：已经打开着就不动。系统发来的「配件已插入」：说明重新插过线，旧链路已失效
      if (it.alive && acc == null) return
      it.close("配件重新插入")
    }
    registerDetach(app)
    val pfd = try {
      um.openAccessory(a)
    } catch (e: Exception) {
      Log.w(TAG, "打开配件失败", e)
      null
    } ?: return
    val s = Session(app, pfd)
    session = s
    s.start()
    Log.i(TAG, "已打开配件，等待电脑端握手")
  }

  @Synchronized
  fun detach() {
    session?.close("数据线已拔出")
    session = null
  }

  /** 某条链路读写出错（拔线）：只关它自己，不影响之后新打开的链路 */
  @Synchronized
  internal fun lost(s: Session) {
    s.close("读写出错，数据线可能已拔出")
    if (session === s) session = null
  }

  internal fun deliver(url: String) {
    pendingUrl = url
    listener?.invoke(url)
  }

  private fun registerDetach(app: Context) {
    if (receiverRegistered) return
    receiverRegistered = true
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context, intent: Intent) {
        if (intent.action == UsbManager.ACTION_USB_ACCESSORY_DETACHED) detach()
      }
    }
    val f = IntentFilter(UsbManager.ACTION_USB_ACCESSORY_DETACHED)
    if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED) else app.registerReceiver(r, f)
  }

  fun deviceName(ctx: Context): String {
    val n = try {
      Settings.Global.getString(ctx.contentResolver, "device_name")
    } catch (e: Exception) {
      null
    }
    return if (!n.isNullOrBlank()) n else listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ")
  }
}

private const val MAGIC: Byte = 0xA5.toByte()
private const val HEADER = 8
private const val T_HELLO = 1
private const val T_CONFIG = 2
private const val T_PONG = 3
private const val T_OPEN = 4
private const val T_DATA = 5
private const val T_CLOSE = 6
private const val T_ACK = 7
private const val MAX_PAYLOAD = 8192
private const val MAX_WRITE = 15000
private const val READ_BUF = 16384
private const val WINDOW = 256 * 1024
private const val ACK_EVERY = 64 * 1024
private const val USB_PACKET = 512
private const val PONG_TIMEOUT_MS = 6000L

private fun frame(type: Int, id: Int, payload: ByteArray = ByteArray(0), off: Int = 0, len: Int = payload.size): ByteArray {
  val b = ByteBuffer.allocate(HEADER + len)
  b.put(MAGIC).put(type.toByte()).putInt(id).putShort(len.toShort())
  b.put(payload, off, len)
  return b.array()
}

private fun ackPayload(n: Int): ByteArray = ByteBuffer.allocate(4).putInt(n).array()

/** 一次打开配件（插一次线、或 App 重开一次）的链路 */
internal class Session(private val ctx: Context, private val pfd: ParcelFileDescriptor) {
  @Volatile var alive = true
  @Volatile private var configured = false
  @Volatile private var lastPong = System.currentTimeMillis()
  private val nonce = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
  private val input = FileInputStream(pfd.fileDescriptor)
  private val output = FileOutputStream(pfd.fileDescriptor)
  private val out = LinkedBlockingQueue<ByteArray>()
  private val streams = ConcurrentHashMap<Int, Stream>()
  private val nextId = AtomicInteger(1)
  private var server: ServerSocket? = null
  private val threads = ArrayList<Thread>()

  fun start() {
    server = listen()
    spawn("p2d-aoa-read") { readLoop() }
    spawn("p2d-aoa-write") { writeLoop() }
    spawn("p2d-aoa-accept") { acceptLoop() }
    spawn("p2d-aoa-hello") { helloLoop() }
  }

  private fun spawn(name: String, body: () -> Unit) {
    val t = Thread({
      try {
        body()
      } catch (e: Exception) {
        if (alive) Log.w(AccessoryLink.TAG, "$name 异常", e)
      }
    }, name)
    t.isDaemon = true
    threads.add(t)
    t.start()
  }

  private fun listen(): ServerSocket {
    val lo = InetAddress.getByName("127.0.0.1")
    return try {
      ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(lo, AccessoryLink.PREFERRED_PORT))
      }
    } catch (e: IOException) {
      ServerSocket(0, 50, lo)
    }
  }

  fun send(f: ByteArray) {
    if (alive) out.offer(f)
  }

  fun close(reason: String) {
    if (!alive) return
    alive = false
    Log.i(AccessoryLink.TAG, "链路关闭：$reason")
    closeStreams()
    try { server?.close() } catch (_: Exception) {}
    try { pfd.close() } catch (_: Exception) {}
    threads.forEach { it.interrupt() }
  }

  private fun closeStreams() {
    val all = streams.values.toList()
    streams.clear()
    all.forEach { it.abort() }
  }

  fun remove(s: Stream) {
    streams.remove(s.id, s)
  }

  /** 每秒发一次握手（也是心跳）；电脑这么久没回应，说明电脑端退出了：作废所有流，等它重新回应 */
  private fun helloLoop() {
    val name = AccessoryLink.deviceName(ctx)
    while (alive) {
      val hello = JSONObject().put("v", 1).put("nonce", nonce).put("name", name).put("app", AccessoryLink.appVersion)
      // 电脑端没在读（电脑端没运行）时写入会一直卡住，队列别越积越多
      if (out.size < 64) send(frame(T_HELLO, 0, hello.toString().toByteArray()))
      if (configured && System.currentTimeMillis() - lastPong > PONG_TIMEOUT_MS) {
        Log.i(AccessoryLink.TAG, "电脑端没有回应，等待重新握手")
        configured = false
        closeStreams()
      }
      try {
        Thread.sleep(1000)
      } catch (e: InterruptedException) {
        return
      }
    }
  }

  private fun readLoop() {
    val buf = ByteArray(READ_BUF) // 配件每次至少读 16 KiB，小于它部分手机会出错
    var pending = ByteArray(0)
    while (alive) {
      val n = try {
        input.read(buf)
      } catch (e: IOException) {
        -1
      }
      if (n < 0) {
        AccessoryLink.lost(this)
        return
      }
      if (n == 0) continue
      lastPong = System.currentTimeMillis()
      var data = if (pending.isEmpty()) buf.copyOf(n) else pending + buf.copyOf(n)
      var pos = 0
      while (data.size - pos >= HEADER) {
        if (data[pos] != MAGIC) { // 格式不对（电脑端中途重启留下的半帧）：丢弃
          pos = data.size
          break
        }
        val bb = ByteBuffer.wrap(data, pos, HEADER)
        bb.get()
        val type = bb.get().toInt() and 0xFF
        val id = bb.int
        val len = bb.short.toInt() and 0xFFFF
        if (len > MAX_PAYLOAD) {
          pos = data.size
          break
        }
        if (data.size - pos < HEADER + len) break
        handle(type, id, data.copyOfRange(pos + HEADER, pos + HEADER + len))
        pos += HEADER + len
      }
      pending = if (pos >= data.size) ByteArray(0) else data.copyOfRange(pos, data.size)
    }
  }

  private fun handle(type: Int, id: Int, payload: ByteArray) {
    when (type) {
      T_CONFIG -> {
        val c = try { JSONObject(String(payload)) } catch (e: Exception) { return }
        if (c.optString("nonce") != nonce) return
        configured = true
        val port = server?.localPort ?: return
        val url = Uri.Builder().scheme("p2d").authority("connect")
          .appendQueryParameter("token", c.optString("token"))
          .appendQueryParameter("host", c.optString("host"))
          .appendQueryParameter("os", c.optString("os"))
          .appendQueryParameter("port", port.toString())
          .apply { c.optString("pcid").takeIf { it.isNotEmpty() }?.let { appendQueryParameter("pcid", it) } }
          .build().toString()
        Log.i(AccessoryLink.TAG, "收到电脑端的连接参数（${c.optString("host")}）")
        AccessoryLink.deliver(url)
      }
      T_PONG -> {}
      T_DATA -> streams[id]?.push(payload)
      T_CLOSE -> streams[id]?.remoteClose()
      T_ACK -> if (payload.size == 4) streams[id]?.grant(ByteBuffer.wrap(payload).int)
    }
  }

  /** 把待发的帧攒成不超过 MAX_WRITE 的一批写出；长度是 512 的整数倍时拆成两次（对方的读请求要等短包才结束） */
  private fun writeLoop() {
    val batch = java.io.ByteArrayOutputStream(MAX_WRITE)
    var carry: ByteArray? = null
    while (alive) {
      batch.reset()
      val first = carry ?: try {
        out.poll(1, TimeUnit.SECONDS) ?: continue
      } catch (e: InterruptedException) {
        return
      }
      carry = null
      batch.write(first)
      while (batch.size() < MAX_WRITE) {
        val f = out.peek() ?: break
        if (batch.size() + f.size > MAX_WRITE) {
          carry = out.poll()
          break
        }
        batch.write(out.poll())
      }
      val data = batch.toByteArray()
      var off = 0
      try {
        while (off < data.size) {
          var n = minOf(data.size - off, MAX_WRITE)
          if (n % USB_PACKET == 0) n--
          output.write(data, off, n)
          off += n
        }
      } catch (e: IOException) {
        AccessoryLink.lost(this)
        return
      }
    }
  }

  private fun acceptLoop() {
    val srv = server ?: return
    while (alive) {
      val sock = try {
        srv.accept()
      } catch (e: IOException) {
        return
      }
      if (!configured) { // 还没拿到电脑的连接参数：拒绝
        try { sock.close() } catch (_: Exception) {}
        continue
      }
      sock.tcpNoDelay = true
      val s = Stream(nextId.getAndIncrement(), sock, this)
      streams[s.id] = s
      send(frame(T_OPEN, s.id))
      s.start()
    }
  }
}

/** 手机上的一条 TCP 连接 ↔ 管道上的一个流 */
internal class Stream(val id: Int, private val sock: Socket, private val session: Session) {
  private val lock = Object()
  private val queue = ArrayDeque<ByteArray>()
  private var sendWin = WINDOW
  private var remoteClosed = false
  private var closed = false

  fun start() {
    Thread({ fromSocket() }, "p2d-aoa-s$id-in").apply { isDaemon = true }.start()
    Thread({ toSocket() }, "p2d-aoa-s$id-out").apply { isDaemon = true }.start()
  }

  /** 本机（JS）→ 电脑 */
  private fun fromSocket() {
    val buf = ByteArray(MAX_PAYLOAD)
    val ins = try { sock.getInputStream() } catch (e: IOException) { finish(true); return }
    while (true) {
      val n = try { ins.read(buf) } catch (e: IOException) { -1 }
      if (n < 0) {
        val tell = synchronized(lock) { !closed && !remoteClosed }
        finish(tell)
        return
      }
      if (n == 0) continue
      synchronized(lock) {
        while (sendWin < n && !closed) {
          try { lock.wait() } catch (e: InterruptedException) { return }
        }
        if (closed) return
        sendWin -= n
      }
      session.send(frame(T_DATA, id, buf, 0, n))
    }
  }

  /** 电脑 → 本机（JS）。写出后回 ACK，电脑才能继续发 */
  private fun toSocket() {
    val os = try { sock.getOutputStream() } catch (e: IOException) { finish(true); return }
    var unacked = 0
    while (true) {
      val p: ByteArray
      val last: Boolean
      synchronized(lock) {
        while (queue.isEmpty() && !remoteClosed && !closed) {
          try { lock.wait() } catch (e: InterruptedException) { return }
        }
        if (closed || queue.isEmpty()) {
          if (unacked > 0) session.send(frame(T_ACK, id, ackPayload(unacked)))
          if (!closed) finish(false)
          return
        }
        p = queue.removeFirst()
        last = queue.isEmpty()
      }
      try {
        os.write(p)
        os.flush()
      } catch (e: IOException) {
        finish(true)
        return
      }
      unacked += p.size
      if (unacked >= ACK_EVERY || last) {
        session.send(frame(T_ACK, id, ackPayload(unacked)))
        unacked = 0
      }
    }
  }

  fun push(p: ByteArray) = synchronized(lock) {
    if (!closed && !remoteClosed) {
      queue.addLast(p)
      lock.notifyAll()
    }
  }

  fun grant(n: Int) = synchronized(lock) {
    sendWin += n
    lock.notifyAll()
  }

  fun remoteClose() = synchronized(lock) {
    remoteClosed = true
    lock.notifyAll()
  }

  /** 结束：tell=true 时告诉电脑这个流关了 */
  private fun finish(tell: Boolean) {
    if (tell) session.send(frame(T_CLOSE, id))
    abort()
    session.remove(this)
  }

  fun abort() {
    synchronized(lock) {
      if (closed) return
      closed = true
      queue.clear()
      lock.notifyAll()
    }
    try { sock.close() } catch (_: Exception) {}
  }
}
