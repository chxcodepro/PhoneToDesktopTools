package expo.modules.p2docr

import android.graphics.BitmapFactory
import android.util.Base64
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** 离线文字识别：输入 base64 图片（JPEG / PNG），返回每一行文字及其在图片中的位置（像素） */
class P2dOcrModule : Module() {
  private val recognizer by lazy { TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()) }

  override fun definition() = ModuleDefinition {
    Name("P2dOcr")

    AsyncFunction("recognizeAsync") { base64: String, promise: Promise ->
      val bytes = try {
        Base64.decode(base64, Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        promise.reject("ERR_OCR_INPUT", "图片数据不是有效的 base64", e)
        return@AsyncFunction
      }
      val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      if (bitmap == null) {
        promise.reject("ERR_OCR_INPUT", "无法解码图片", null)
        return@AsyncFunction
      }
      recognizer.process(InputImage.fromBitmap(bitmap, 0))
        .addOnSuccessListener { result ->
          val lines = ArrayList<Map<String, Any>>()
          for (block in result.textBlocks) {
            for (line in block.lines) {
              val box = line.boundingBox ?: continue
              lines.add(
                mapOf(
                  "text" to line.text,
                  "x" to box.left,
                  "y" to box.top,
                  "w" to box.width(),
                  "h" to box.height(),
                ),
              )
            }
          }
          promise.resolve(
            mapOf("width" to bitmap.width, "height" to bitmap.height, "lines" to lines),
          )
        }
        .addOnFailureListener { e -> promise.reject("ERR_OCR", e.message ?: "文字识别失败", e) }
    }
  }
}
