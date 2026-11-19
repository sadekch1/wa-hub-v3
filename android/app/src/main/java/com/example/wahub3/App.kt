package com.example.wahub3

import android.app.Application
import android.os.Build
import com.example.wahub3.watch.WatchStore
import java.io.File

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                File(filesDir, "crash.txt").writeText("thread=${t.name}\n" + e.stackTraceToString().take(3000))
            } catch (_: Throwable) {}
            prev?.uncaughtException(t, e)
        }
        if (isMainProcess()) {
            Repo.init(applicationContext)
            // مخزن غرف المشاهدة: يسجّل مستمع الأجزاء لعمر التطبيق + فحص انتهاء مهلة الإكمال
            WatchStore.init(applicationContext)
            WatchStore.runExpiryCheck()
        }
    }

    private fun isMainProcess(): Boolean =
        if (Build.VERSION.SDK_INT >= 28) {
            Application.getProcessName() == packageName
        } else {
            try { File("/proc/self/cmdline").readText().trim('\u0000') == packageName } catch (_: Exception) { true }
        }
}
