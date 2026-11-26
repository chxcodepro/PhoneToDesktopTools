package expo.modules.p2dscreen

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** 一块画面：编码后画面上的位置和尺寸，JPEG base64 */
class TileRecord : Record {
  @Field var x: Int = 0
  @Field var y: Int = 0
  @Field var w: Int = 0
  @Field var h: Int = 0
  @Field var data: String = ""
}

/**
 * 虚拟桌面原生画布。
 *
 * JS 收到 p2d/screen.tiles 后调用 draw：在后台线程并行解码各块 JPEG，按顺序画到这个画布 id 的位图上，
 * 再让显示这个画布的 ScreenCanvasView 重绘。画面数据不经过 React 状态和 Image 组件。
 */
class P2dScreenModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("P2dScreen")

    OnDestroy {
      CanvasRegistry.releaseAll()
    }

    AsyncFunction("draw") { id: String, width: Int, height: Int, full: Boolean, tiles: List<TileRecord>, promise: Promise ->
      CanvasRegistry.draw(id, width, height, full, tiles) { error ->
        if (error == null) promise.resolve(null) else promise.reject("ERR_SCREEN_DRAW", error, null)
      }
    }

    Function("release") { id: String ->
      CanvasRegistry.release(id)
    }

    View(ScreenCanvasView::class) {
      Prop("canvasId") { view: ScreenCanvasView, id: String ->
        view.setCanvasId(id)
      }
    }
  }
}
