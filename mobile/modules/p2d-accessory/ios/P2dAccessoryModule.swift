import ExpoModulesCore
import UIKit

/// iPhone 数据线连接：把电脑经 usbmuxd 发来的连接链接交给 JS（接口和安卓的免调试连接模块相同，JS 共用一套逻辑）
public class P2dAccessoryModule: Module {
  public func definition() -> ModuleDefinition {
    Name("P2dAccessory")

    /// 收到电脑端的连接参数：{ url: "p2d://connect?…" }
    Events("onConnect")

    OnCreate {
      let link = UsbmuxLink.shared
      link.listener = { [weak self] url in self?.sendEvent("onConnect", ["url": url]) }
      DispatchQueue.main.async { link.deviceName = UIDevice.current.name }
      link.start()
    }

    OnDestroy {
      UsbmuxLink.shared.listener = nil
    }

    // iOS 挂起 App 期间监听的套接字可能失效，回到前台时重新监听；电脑端会自动重连
    OnAppEntersForeground {
      UsbmuxLink.shared.start()
    }

    /// 取走还没处理的连接链接（JS 加载完成前电脑就发来了），没有时返回 null
    Function("takePending") { () -> String? in
      UsbmuxLink.shared.takePending()
    }

    /// 数据线链路是否连着
    Function("isOpen") { () -> Bool in
      UsbmuxLink.shared.isOpen()
    }

    /// 告诉电脑端手机端的版本（握手时带上）
    Function("setAppVersion") { (v: String) in
      UsbmuxLink.shared.appVersion = v
    }
  }
}
