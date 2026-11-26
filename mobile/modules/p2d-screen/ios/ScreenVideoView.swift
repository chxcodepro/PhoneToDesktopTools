import AVFoundation
import CoreMedia
import ExpoModulesCore
import UIKit
import VideoToolbox

/// 显示硬件解码的视频（和 Android 版 ScreenVideoView 对应）：系统的 AVSampleBufferDisplayLayer 直接解码显示 H.264。
final class ScreenVideoView: ExpoView {
  let displayLayer = AVSampleBufferDisplayLayer()
  private(set) var videoId: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    clipsToBounds = true
    displayLayer.videoGravity = .resize
    layer.addSublayer(displayLayer)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    displayLayer.frame = bounds
    CATransaction.commit()
  }

  func setVideoId(_ id: String) {
    if id == videoId { return }
    if let old = videoId {
      VideoRegistry.shared.detach(id: old, view: self)
    }
    videoId = id
    VideoRegistry.shared.attach(id: id, view: self)
  }
}

/// 一路视频：解析 SPS/PPS 建格式描述，把 Annex B 转成长度前缀格式交给显示层
final class VideoStreamIOS {
  private var format: CMVideoFormatDescription?
  private var sps = Data()
  private var pps = Data()
  /// 显示层换了（视图重建）或出错后，要等关键帧
  var needKey = true

  func feed(_ data: Data, key: Bool, layer: AVSampleBufferDisplayLayer?) -> String {
    let nals = VideoStreamIOS.split(data)
    if key {
      var s = sps
      var p = pps
      for n in nals {
        if n.first.map({ $0 & 0x1f }) == 7 { s = n }
        if n.first.map({ $0 & 0x1f }) == 8 { p = n }
      }
      if s != sps || p != pps || format == nil {
        sps = s
        pps = p
        format = VideoStreamIOS.makeFormat(sps: s, pps: p)
      }
    }
    guard let layer = layer, let fmt = format else { return key ? "dropped" : "needKey" }
    if needKey && !key { return "needKey" }
    if layer.status == .failed {
      layer.flush()
      needKey = true
      return "needKey"
    }
    var avcc = Data()
    for n in nals {
      let t = n.first.map { $0 & 0x1f } ?? 0
      if t == 7 || t == 8 || t == 9 { continue }  // 参数集放在格式描述里，分隔符不要
      var len = UInt32(n.count).bigEndian
      avcc.append(Data(bytes: &len, count: 4))
      avcc.append(n)
    }
    guard !avcc.isEmpty, let sample = VideoStreamIOS.makeSample(avcc, format: fmt) else { return "dropped" }
    layer.enqueue(sample)
    if key { needKey = false }
    return "ok"
  }

  /// 按起始码切出各个 NAL（不含起始码）
  static func split(_ d: Data) -> [Data] {
    let b = [UInt8](d)
    var starts: [Int] = []
    var i = 0
    while i + 3 <= b.count {
      if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
        starts.append(i + 3)
        i += 3
      } else {
        i += 1
      }
    }
    var out: [Data] = []
    for (n, s) in starts.enumerated() {
      var end = n + 1 < starts.count ? starts[n + 1] - 3 : b.count
      if n + 1 < starts.count && end > s && b[end - 1] == 0 { end -= 1 }
      if end > s { out.append(Data(b[s..<end])) }
    }
    return out
  }

  static func makeFormat(sps: Data, pps: Data) -> CMVideoFormatDescription? {
    guard !sps.isEmpty, !pps.isEmpty else { return nil }
    var fmt: CMVideoFormatDescription?
    let status = sps.withUnsafeBytes { (sp: UnsafeRawBufferPointer) -> OSStatus in
      pps.withUnsafeBytes { (pp: UnsafeRawBufferPointer) -> OSStatus in
        let ptrs: [UnsafePointer<UInt8>] = [
          sp.bindMemory(to: UInt8.self).baseAddress!, pp.bindMemory(to: UInt8.self).baseAddress!,
        ]
        let sizes = [sps.count, pps.count]
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: ptrs,
          parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &fmt)
      }
    }
    return status == noErr ? fmt : nil
  }

  static func makeSample(_ avcc: Data, format: CMVideoFormatDescription) -> CMSampleBuffer? {
    var block: CMBlockBuffer?
    guard
      CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: avcc.count, blockAllocator: kCFAllocatorDefault,
        customBlockSource: nil, offsetToData: 0, dataLength: avcc.count, flags: kCMBlockBufferAssureMemoryNowFlag,
        blockBufferOut: &block) == noErr, let bb = block
    else { return nil }
    let copied = avcc.withUnsafeBytes { p in
      CMBlockBufferReplaceDataBytes(with: p.baseAddress!, blockBuffer: bb, offsetIntoDestination: 0, dataLength: avcc.count)
    }
    guard copied == noErr else { return nil }
    var sample: CMSampleBuffer?
    var size = avcc.count
    guard
      CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault, dataBuffer: bb, formatDescription: format, sampleCount: 1,
        sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size,
        sampleBufferOut: &sample) == noErr, let s = sample
    else { return nil }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(s, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
      let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(
        dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    return s
  }

  /// 能硬件解码 H.264 时返回上限
  static func caps() -> [String: Int]? {
    guard VTIsHardwareDecodeSupported(kCMVideoCodecType_H264) else { return nil }
    return ["maxWidth": 4096, "maxHeight": 2304, "maxFps": 60]
  }
}

/// 视频流和视图按 id 对应。送帧和显示都在主线程做（显示层不是线程安全的）
final class VideoRegistry {
  static let shared = VideoRegistry()

  private var streams: [String: VideoStreamIOS] = [:]
  private var views: [String: ScreenVideoView] = [:]

  func feed(id: String, data: Data, key: Bool, done: @escaping (String) -> Void) {
    DispatchQueue.main.async {
      let s = self.streams[id] ?? VideoStreamIOS()
      self.streams[id] = s
      done(s.feed(data, key: key, layer: self.views[id]?.displayLayer))
    }
  }

  func attach(id: String, view: ScreenVideoView) {
    DispatchQueue.main.async {
      self.views[id] = view
      self.streams[id]?.needKey = true
    }
  }

  func detach(id: String, view: ScreenVideoView) {
    DispatchQueue.main.async {
      if self.views[id] === view { self.views.removeValue(forKey: id) }
    }
  }

  func release(id: String) {
    DispatchQueue.main.async {
      self.streams.removeValue(forKey: id)
      self.views[id]?.displayLayer.flushAndRemoveImage()
    }
  }

  func releaseAll() {
    DispatchQueue.main.async {
      self.streams.removeAll()
    }
  }
}
