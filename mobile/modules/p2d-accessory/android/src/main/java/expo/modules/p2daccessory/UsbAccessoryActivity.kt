package expo.modules.p2daccessory

import android.app.Activity
import android.content.Intent
import android.hardware.usb.UsbAccessory
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle

/**
 * 用户在系统弹窗里点了「用 p2d 打开」：打开配件（此时 App 已获得访问权限），拉起主界面后立即关闭。
 * 透明主题，用户看不到这个页面。
 */
class UsbAccessoryActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val acc: UsbAccessory? = if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(UsbManager.EXTRA_ACCESSORY, UsbAccessory::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(UsbManager.EXTRA_ACCESSORY)
    }
    if (acc != null) AccessoryLink.attach(applicationContext, acc)
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      startActivity(it)
    }
    finish()
  }
}
