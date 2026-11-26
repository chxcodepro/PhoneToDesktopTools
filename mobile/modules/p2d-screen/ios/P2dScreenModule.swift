import ExpoModulesCore
import ImageIO
import UIKit

/// 一块画面：编码后画面上的位置和尺寸，JPEG base64
struct TileRecord: Record {
  @Field var x: Int = 0
  @Field var y: Int = 0
  @Field var w: Int = 0
  @Field var h: Int = 0
  @Field var data: String = ""
}

/// 虚拟桌面原生画布（和 Android 版对应）：后台并行解码各块 JPEG，按顺序画到画布上，再刷新显示它的视图。
public final class P2dScreenModule: Module {
  public func definition() -> ModuleDefinition {
    Name("P2dScreen")

    OnDestroy {
      CanvasRegistry.shared.releaseAll()
    }

    AsyncFunction("draw") { (id: String, width: Int, height: Int, full: Bool, tiles: [TileRecord], promise: Promise) in
      CanvasRegistry.shared.draw(id: id, width: width, height: height, full: full, tiles: tiles) { error in
        if let error = error {
          promise.reject("ERR_SCREEN_DRAW", error)
        } else {
          promise.resolve(nil)
        }
      }
    }

    Function("release") { (id: String) in
      CanvasRegistry.shared.release(id: id)
    }

    View(ScreenCanvasView.self) {
      Prop("canvasId") { (view: ScreenCanvasView, id: String) in
        view.setCanvasId(id)
      }
    }
  }
}

/// 一块画布：和电脑端编码后的画面一样大的位图
final class ScreenCanvas {
  let width: Int
  let height: Int
  let context: CGContext

  init?(width: Int, height: Int) {
    guard width > 0, height > 0,
      let ctx = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    self.width = width
    self.height = height
    self.context = ctx
    ctx.setFillColor(UIColor.black.cgColor)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.interpolationQuality = .none
  }

  /// 画一块（CoreGraphics 的坐标原点在左下角，要翻过来）
  func draw(_ image: CGImage, x: Int, y: Int, w: Int, h: Int) {
    context.draw(image, in: CGRect(x: x, y: height - y - h, width: w, height: h))
  }
}

/// 画布按 id 登记，所有 draw / release 在同一个串行队列上按调用顺序执行
final class CanvasRegistry {
  static let shared = CanvasRegistry()

  private let queue = DispatchQueue(label: "p2d.screen")
  private var canvases: [String: ScreenCanvas] = [:]  // 只在 queue 上访问
  private let viewsLock = NSLock()
  private var views: [String: NSHashTable<ScreenCanvasView>] = [:]

  func draw(id: String, width: Int, height: Int, full: Bool, tiles: [TileRecord], done: @escaping (String?) -> Void) {
    queue.async {
      var canvas = self.canvases[id]
      if canvas == nil || canvas!.width != width || canvas!.height != height {
        canvas = ScreenCanvas(width: width, height: height)
        self.canvases[id] = canvas
      }
      guard let c = canvas else {
        done("画布尺寸无效：\(width)x\(height)")
        return
      }
      // 并行解码
      var images = [CGImage?](repeating: nil, count: tiles.count)
      let lock = NSLock()
      DispatchQueue.concurrentPerform(iterations: tiles.count) { i in
        guard let bytes = Data(base64Encoded: tiles[i].data),
          let src = CGImageSourceCreateWithData(bytes as CFData, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return }
        lock.lock()
        images[i] = img
        lock.unlock()
      }
      for (i, img) in images.enumerated() {
        guard let img = img else { continue }
        let t = tiles[i]
        c.draw(img, x: t.x, y: t.y, w: t.w, h: t.h)
      }
      let snapshot = c.context.makeImage()
      self.show(id: id, image: snapshot)
      done(nil)
    }
  }

  func release(id: String) {
    queue.async {
      self.canvases.removeValue(forKey: id)
      self.show(id: id, image: nil)
    }
  }

  func releaseAll() {
    queue.async {
      self.canvases.removeAll()
    }
  }

  /// 视图挂上来时补一张当前画面
  func current(id: String, _ callback: @escaping (CGImage?) -> Void) {
    queue.async {
      let img = self.canvases[id]?.context.makeImage()
      DispatchQueue.main.async { callback(img) }
    }
  }

  func attach(id: String, view: ScreenCanvasView) {
    viewsLock.lock()
    let table = views[id] ?? NSHashTable<ScreenCanvasView>.weakObjects()
    table.add(view)
    views[id] = table
    viewsLock.unlock()
  }

  func detach(id: String, view: ScreenCanvasView) {
    viewsLock.lock()
    views[id]?.remove(view)
    viewsLock.unlock()
  }

  private func show(id: String, image: CGImage?) {
    viewsLock.lock()
    let list = views[id]?.allObjects ?? []
    viewsLock.unlock()
    DispatchQueue.main.async {
      for v in list where v.canvasId == id {
        v.layer.contents = image
      }
    }
  }
}
