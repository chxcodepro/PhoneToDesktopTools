import ExpoModulesCore
import UIKit
import Vision

/// 离线文字识别（iOS 系统自带的 Vision，支持简体中文）：输入 base64 图片（JPEG / PNG），
/// 返回每一行文字及其在图片中的位置（像素，左上角为原点），格式和安卓版（ML Kit）相同
public class P2dOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("P2dOcr")

    AsyncFunction("recognizeAsync") { (base64: String, promise: Promise) in
      guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
        promise.reject("ERR_OCR_INPUT", "图片数据不是有效的 base64")
        return
      }
      guard let image = UIImage(data: data), let cg = image.cgImage else {
        promise.reject("ERR_OCR_INPUT", "无法解码图片")
        return
      }
      let width = cg.width
      let height = cg.height
      let request = VNRecognizeTextRequest { req, err in
        if let err = err {
          promise.reject("ERR_OCR", err.localizedDescription)
          return
        }
        var lines: [[String: Any]] = []
        for case let obs as VNRecognizedTextObservation in req.results ?? [] {
          guard let top = obs.topCandidates(1).first else { continue }
          // Vision 的坐标是 0~1、原点在左下角，换成像素、原点在左上角
          let b = obs.boundingBox
          lines.append([
            "text": top.string,
            "x": Int((b.minX * CGFloat(width)).rounded()),
            "y": Int(((1 - b.maxY) * CGFloat(height)).rounded()),
            "w": Int((b.width * CGFloat(width)).rounded()),
            "h": Int((b.height * CGFloat(height)).rounded()),
          ])
        }
        promise.resolve(["width": width, "height": height, "lines": lines])
      }
      request.recognitionLevel = .accurate
      request.recognitionLanguages = ["zh-Hans", "en-US"]
      request.usesLanguageCorrection = true
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
        } catch {
          promise.reject("ERR_OCR", error.localizedDescription)
        }
      }
    }
  }
}
