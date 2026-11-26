package expo.modules.p2dscreen

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.util.Base64
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** 一块画布：和电脑端编码后的画面一样大的位图 */
internal class ScreenCanvas(val width: Int, val height: Int) {
  val bitmap: Bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLACK) }
  private val canvas = Canvas(bitmap)

  fun drawTile(tile: Bitmap, x: Int, y: Int) {
    canvas.drawBitmap(tile, x.toFloat(), y.toFloat(), null)
  }
}

/**
 * 画布按 id 登记，和显示它的视图分开：页面重新挂载视图时画面还在。
 * 所有 draw / release 都在同一个串行线程上按调用顺序执行，块的解码分给几个线程并行。
 */
internal object CanvasRegistry {
  private val canvases = ConcurrentHashMap<String, ScreenCanvas>()
  private val views = HashMap<String, MutableSet<ScreenCanvasView>>()
  private val serial = Executors.newSingleThreadExecutor { r -> Thread(r, "p2d-screen").apply { isDaemon = true } }
  private val decoders = Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors().coerceIn(2, 4)) { r ->
    Thread(r, "p2d-screen-decode").apply { isDaemon = true }
  }

  fun get(id: String): ScreenCanvas? = canvases[id]

  /** full：整屏重发（尺寸不变时块会盖满整个画布，所以不用先清空） */
  fun draw(id: String, width: Int, height: Int, @Suppress("UNUSED_PARAMETER") full: Boolean, tiles: List<TileRecord>, done: (String?) -> Unit) {
    serial.execute {
      try {
        var c = canvases[id]
        if (c == null || c.width != width || c.height != height) {
          c = ScreenCanvas(width, height)
          canvases[id] = c
        }
        val decoded = tiles.map { t -> decoders.submit(Callable { decode(t.data) }) }
        decoded.forEachIndexed { i, f ->
          val b = f.get() ?: return@forEachIndexed
          c.drawTile(b, tiles[i].x, tiles[i].y)
          b.recycle()
        }
        invalidate(id)
        done(null)
      } catch (e: Throwable) {
        done(e.message ?: e.toString())
      }
    }
  }

  fun release(id: String) {
    serial.execute {
      // 不调用 recycle：界面线程可能正在画它，交给垃圾回收
      canvases.remove(id)
      invalidate(id)
    }
  }

  fun releaseAll() {
    serial.execute {
      canvases.clear()
    }
  }

  fun attach(id: String, view: ScreenCanvasView) {
    synchronized(views) {
      views.getOrPut(id) { Collections.newSetFromMap(WeakHashMap()) }.add(view)
    }
  }

  fun detach(id: String, view: ScreenCanvasView) {
    synchronized(views) {
      views[id]?.remove(view)
      if (views[id]?.isEmpty() == true) views.remove(id)
    }
  }

  private fun invalidate(id: String) {
    val list = synchronized(views) { views[id]?.toList() } ?: return
    for (v in list) v.postInvalidateOnAnimation()
  }

  private fun decode(data: String): Bitmap? {
    if (data.isEmpty()) return null
    val bytes = Base64.decode(data, Base64.DEFAULT)
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
  }
}
