package expo.modules.p2dscreen

import android.content.Context
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * 显示硬件解码的视频：里面放一个 TextureView，解码器直接画到它的 Surface 上。
 * 用 TextureView（不用 SurfaceView）是因为外层捏合放大、平移用的是 React Native 的 transform，TextureView 跟着变换。
 */
class ScreenVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext), TextureView.SurfaceTextureListener {
  private var videoId: String? = null
  private var surface: Surface? = null
  private val texture = TextureView(context)

  override val shouldUseAndroidLayout = true

  init {
    setBackgroundColor(Color.BLACK)
    texture.surfaceTextureListener = this
    texture.isOpaque = true
    addView(texture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    texture.layout(0, 0, r - l, b - t)
  }

  fun setVideoId(id: String) {
    if (id == videoId) return
    videoId?.let { VideoRegistry.setSurface(it, null) }
    videoId = id
    surface?.let { VideoRegistry.setSurface(id, it) }
  }

  override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
    val s = Surface(st)
    surface = s
    videoId?.let { VideoRegistry.setSurface(it, s) }
  }

  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}

  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    videoId?.let { VideoRegistry.setSurface(it, null) }
    surface?.release()
    surface = null
    return true
  }

  override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
}
