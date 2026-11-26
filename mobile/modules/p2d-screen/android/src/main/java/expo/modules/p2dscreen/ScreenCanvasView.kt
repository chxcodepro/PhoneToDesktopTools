package expo.modules.p2dscreen

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** 显示一块画布：把画布位图缩放铺满视图（外层捏合放大时由系统按放大后的尺寸采样，文字不会糊） */
class ScreenCanvasView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var canvasId: String? = null
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val dst = Rect()

  init {
    setWillNotDraw(false)
    setBackgroundColor(Color.BLACK)
  }

  fun setCanvasId(id: String) {
    if (id == canvasId) return
    canvasId?.let { CanvasRegistry.detach(it, this) }
    canvasId = id
    CanvasRegistry.attach(id, this)
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val c = canvasId?.let { CanvasRegistry.get(it) } ?: return
    dst.set(0, 0, width, height)
    canvas.drawBitmap(c.bitmap, null, dst, paint)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    canvasId?.let { CanvasRegistry.attach(it, this) }
  }

  override fun onDetachedFromWindow() {
    canvasId?.let { CanvasRegistry.detach(it, this) }
    super.onDetachedFromWindow()
  }
}
