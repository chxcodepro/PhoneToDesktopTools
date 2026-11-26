import ExpoModulesCore
import UIKit

/// 显示一块画布：画面作为图层内容缩放铺满视图
final class ScreenCanvasView: ExpoView {
  private(set) var canvasId: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    clipsToBounds = true
    layer.contentsGravity = .resize
    layer.magnificationFilter = .linear
    layer.minificationFilter = .linear
  }

  func setCanvasId(_ id: String) {
    if id == canvasId { return }
    if let old = canvasId {
      CanvasRegistry.shared.detach(id: old, view: self)
    }
    canvasId = id
    CanvasRegistry.shared.attach(id: id, view: self)
    CanvasRegistry.shared.current(id: id) { [weak self] img in
      guard let self = self, self.canvasId == id, let img = img else { return }
      self.layer.contents = img
    }
  }
}
