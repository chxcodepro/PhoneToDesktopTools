package expo.modules.p2dscreen

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap

/** 一帧的处理结果，返回给 JS：ok 已显示（或已交给解码器），dropped 丢弃，needKey 解码器要关键帧才能继续 */
object VideoResult {
  const val OK = "ok"
  const val DROPPED = "dropped"
  const val NEED_KEY = "needKey"
}

/**
 * 电脑端推来的 H.264（Annex B）用 MediaCodec 硬件解码，直接输出到 ScreenVideoView 的 Surface 上，画面数据不回到 JS。
 *
 * 解码器跑在自己的线程上（异步回调模式），所有状态只在这个线程里改。
 * 关键帧带 SPS/PPS：第一次收到、或分辨率变了时（重新）创建解码器；没有解码器时收到普通帧就回 needKey，JS 端请电脑发关键帧。
 */
class VideoDecoder(private val id: String) {
  private class Frame(val data: ByteArray, val pts: Long, val done: (String) -> Unit)

  private val thread = HandlerThread("p2d-video-$id").apply { start() }
  private val handler = Handler(thread.looper)
  private var surface: Surface? = null
  private var codec: MediaCodec? = null
  private var sps: ByteArray? = null
  private var pps: ByteArray? = null
  private var width = 0
  private var height = 0
  private var nextPts = 0L
  private val freeInputs = ArrayDeque<Int>()
  private val waiting = ArrayDeque<Frame>() // 等解码器的输入缓冲区
  private val decoding = ArrayDeque<Frame>() // 已经送进解码器，等输出

  private val callback = object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(c: MediaCodec, index: Int) {
      if (c !== codec) return
      freeInputs.addLast(index)
      pump()
    }

    override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      if (c !== codec) return
      try {
        c.releaseOutputBuffer(index, true)
      } catch (e: IllegalStateException) {
        return
      }
      while (decoding.isNotEmpty() && decoding.first().pts <= info.presentationTimeUs) {
        decoding.removeFirst().done(VideoResult.OK)
      }
    }

    override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
      if (c !== codec) return
      Log.w(TAG, "解码出错，等关键帧重新开始", e)
      releaseCodec(VideoResult.NEED_KEY)
    }

    override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {}
  }

  /** 送一帧进来（任意线程调用），处理完回调 done */
  fun feed(data: ByteArray, key: Boolean, w: Int, h: Int, done: (String) -> Unit) {
    handler.post { feedOnThread(data, key, w, h, done) }
  }

  fun setSurface(s: Surface?) {
    handler.post {
      if (s === surface) return@post
      surface = s
      val c = codec ?: return@post
      if (s == null) {
        releaseCodec(VideoResult.DROPPED) // 画面被回收：等新的 Surface 和关键帧
      } else {
        try {
          c.setOutputSurface(s) // 换了 Surface（比如页面重建）：继续解码，不用关键帧
        } catch (e: Exception) {
          releaseCodec(VideoResult.NEED_KEY)
        }
      }
    }
  }

  fun release() {
    handler.post {
      releaseCodec(VideoResult.DROPPED)
      surface = null
      thread.quitSafely()
    }
  }

  private fun feedOnThread(data: ByteArray, key: Boolean, w: Int, h: Int, done: (String) -> Unit) {
    if (key) {
      val (s, p) = paramSets(data)
      if (s != null && p != null && (codec == null || !s.contentEquals(sps) || !p.contentEquals(pps) || w != width || h != height)) {
        releaseCodec(VideoResult.DROPPED)
        sps = s
        pps = p
        width = w
        height = h
      }
    }
    if (codec == null) {
      if (!key || sps == null || surface == null) {
        done(if (key) VideoResult.DROPPED else VideoResult.NEED_KEY)
        return
      }
      if (!configure()) {
        done(VideoResult.NEED_KEY)
        return
      }
    }
    waiting.addLast(Frame(data, nextPts, done))
    nextPts += 1000
    pump()
  }

  private fun configure(): Boolean {
    val s = surface ?: return false
    return try {
      val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
      fmt.setByteBuffer("csd-0", ByteBuffer.wrap(sps!!))
      fmt.setByteBuffer("csd-1", ByteBuffer.wrap(pps!!))
      fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, maxOf(width * height, 1 shl 20))
      fmt.setInteger(MediaFormat.KEY_PRIORITY, 0) // 实时
      val name = MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(fmt)
      val c = if (name != null) MediaCodec.createByCodecName(name) else MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
      if (Build.VERSION.SDK_INT >= 30 &&
        c.codecInfo.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
      ) {
        fmt.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
      }
      // 高通解码器的低延迟开关（不加时会攒几帧才出画面）
      if (c.name.startsWith("c2.qti") || c.name.startsWith("OMX.qcom")) {
        fmt.setInteger("vendor.qti-ext-dec-low-latency.enable", 1)
        fmt.setInteger("vendor.qti-ext-dec-picture-order.enable", 1)
      }
      c.setCallback(callback, handler)
      c.configure(fmt, s, null, 0)
      c.start()
      codec = c
      Log.i(TAG, "解码器 ${c.name}，${width}x$height")
      true
    } catch (e: Exception) {
      Log.w(TAG, "创建解码器失败", e)
      false
    }
  }

  private fun pump() {
    val c = codec ?: return
    while (freeInputs.isNotEmpty() && waiting.isNotEmpty()) {
      val index = freeInputs.removeFirst()
      val f = waiting.removeFirst()
      try {
        val buf = c.getInputBuffer(index) ?: continue
        buf.clear()
        buf.put(f.data)
        c.queueInputBuffer(index, 0, f.data.size, f.pts, 0)
        decoding.addLast(f)
      } catch (e: Exception) {
        f.done(VideoResult.NEED_KEY)
        releaseCodec(VideoResult.NEED_KEY)
        return
      }
    }
    // 解码器攒着不出画面时（个别机型），最早的帧先当作完成，电脑端不会因为等确认卡住
    while (decoding.size > 2) decoding.removeFirst().done(VideoResult.OK)
  }

  private fun releaseCodec(result: String) {
    val c = codec
    codec = null
    freeInputs.clear()
    if (c != null) {
      try {
        c.stop()
      } catch (_: Exception) {
      }
      try {
        c.release()
      } catch (_: Exception) {
      }
    }
    while (decoding.isNotEmpty()) decoding.removeFirst().done(result)
    while (waiting.isNotEmpty()) waiting.removeFirst().done(result)
  }

  companion object {
    private const val TAG = "P2dVideo"

    /** 从 Annex B 数据里取 SPS 和 PPS（带起始码，作为 csd-0 / csd-1） */
    fun paramSets(b: ByteArray): Pair<ByteArray?, ByteArray?> {
      var sps: ByteArray? = null
      var pps: ByteArray? = null
      val starts = ArrayList<Int>()
      var i = 0
      while (i + 3 <= b.size) {
        if (b[i] == 0.toByte() && b[i + 1] == 0.toByte() && b[i + 2] == 1.toByte()) {
          starts.add(i)
          i += 3
        } else {
          i++
        }
      }
      for ((n, s) in starts.withIndex()) {
        val payload = s + 3
        if (payload >= b.size) continue
        var end = if (n + 1 < starts.size) starts[n + 1] else b.size
        if (end > payload && n + 1 < starts.size && b[end - 1] == 0.toByte()) end-- // 下一个是 4 字节起始码
        val type = b[payload].toInt() and 0x1f
        val nal = ByteArray(4 + end - payload)
        nal[3] = 1
        System.arraycopy(b, payload, nal, 4, end - payload)
        if (type == 7) sps = nal
        if (type == 8) pps = nal
      }
      return Pair(sps, pps)
    }

    /** 这台手机硬件解码 H.264 的上限：最大宽高和最高帧率（按最大宽高时） */
    fun caps(): Map<String, Int>? {
      val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
      var best: Map<String, Int>? = null
      for (info in list.codecInfos) {
        if (info.isEncoder || !info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) }) continue
        if (Build.VERSION.SDK_INT >= 29 && !info.isHardwareAccelerated) continue
        if (info.name.startsWith("OMX.google") || info.name.startsWith("c2.android")) continue // 软件解码器
        val vc = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).videoCapabilities ?: continue
        val w = vc.supportedWidths.upper
        val h = vc.supportedHeights.upper
        // 横屏画面：宽是长边。取 宽≥高 时都支持的最大尺寸
        val maxW = maxOf(w, h)
        var maxH = minOf(w, h)
        if (!vc.isSizeSupported(maxW, maxH)) maxH = vc.getSupportedHeightsFor(minOf(maxW, w)).upper
        val fps = try {
          vc.getSupportedFrameRatesFor(minOf(1920, maxW), minOf(1080, maxH)).upper.toInt()
        } catch (_: Exception) {
          60
        }
        val c = mapOf("maxWidth" to maxW, "maxHeight" to maxH, "maxFps" to fps)
        if (best == null || maxW * maxH > best["maxWidth"]!! * best["maxHeight"]!!) best = c
      }
      return best
    }
  }
}

/** 解码器和视图按 id 对应起来 */
object VideoRegistry {
  private val decoders = ConcurrentHashMap<String, VideoDecoder>()
  private val surfaces = ConcurrentHashMap<String, Surface>()

  fun decoder(id: String): VideoDecoder = decoders.getOrPut(id) {
    VideoDecoder(id).also { d -> surfaces[id]?.let { d.setSurface(it) } }
  }

  fun setSurface(id: String, s: Surface?) {
    if (s == null) surfaces.remove(id) else surfaces[id] = s
    decoders[id]?.setSurface(s)
  }

  fun release(id: String) {
    decoders.remove(id)?.release()
  }

  fun releaseAll() {
    for (id in decoders.keys.toList()) release(id)
  }
}
