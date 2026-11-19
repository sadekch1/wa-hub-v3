package com.example.wahub3.watch

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import java.io.File
import android.content.pm.ActivityInfo
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.ColorUtils
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.example.wahub3.LauncherActivity
import com.example.wahub3.Prefs
import com.example.wahub3.Repo
import java.util.TreeMap
import java.util.concurrent.Executors

/**
 * شاشة المشاهدة: بيت الغرف + مشغّل الغرفة المفتوحة.
 *
 * الأجزاء الواصلة ملكٌ لـ WatchStore (تُحفظ دائماً ولا تُحذف بعد التشغيل، ولا دمج).
 * هذه الشاشة تعرض الغرف والأقسام، وتشغّل أجزاء الغرفة المفتوحة بالترتيب.
 */
@UnstableApi
class WatchActivity : AppCompatActivity() {

    // ───────────────────────── Models ─────────────────────────

    /** key = رقم الجزء (أو وقت الوصول إن لم يوجد رقم)، strict = ترقيم تسلسلي يصلح لكشف الفجوات */
    private class Seg(val uri: Uri, val name: String, val key: Long, val strict: Boolean, val fileName: String) {
        var arrivedAt = 0L
    }

    private class Palette(
        val name: String,
        val bg: Int,
        val surface: Int,
        val surface2: Int,
        val text: Int,
        val sub: Int,
        val dark: Boolean
    )

    private fun c(s: String) = Color.parseColor(s)

    // نفس لوحات ui/Theme.kt الخمس — تُقرأ من نفس Prefs.theme
    private val palettes by lazy {
        listOf(
            Palette("ليلي عصري", c("#0B1220"), c("#131C30"), c("#1E2A45"), c("#EDF2FF"), c("#93A5C8"), true),
            Palette("نهاري", c("#F3F5F9"), c("#FFFFFF"), c("#E8ECF3"), c("#14171F"), c("#5B6475"), false),
            Palette("AMOLED", c("#000000"), c("#0A0A0C"), c("#17171B"), c("#FFFFFF"), c("#8A8F9C"), true),
            Palette("بنفسجي", c("#120A24"), c("#1E1238"), c("#2D1B52"), c("#F3EEFF"), c("#B3A6D9"), true),
            Palette("زمردي", c("#071A14"), c("#0E2A21"), c("#174233"), c("#E9FFF6"), c("#8FC7B2"), true)
        )
    }
    private val accents by lazy {
        listOf("#3D8BFF", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#EC4899").map { c(it) }
    }

    private val resizeModes = arrayOf(
        AspectRatioFrameLayout.RESIZE_MODE_FIT to "ملاءمة",
        AspectRatioFrameLayout.RESIZE_MODE_FILL to "تعبئة",
        AspectRatioFrameLayout.RESIZE_MODE_ZOOM to "تكبير/قص"
    )
    private val bufferOptions = listOf(3, 5, 8, 12)
    // انتظار الجزء الغائب بلا نهاية دائماً (maxWaitSec = 0) — لا تخطّي أبداً

    // ───────────────────────── Views ─────────────────────────

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var playerContainer: FrameLayout
    private lateinit var controlsLayout: ScrollView
    private lateinit var tvStatus: TextView
    private lateinit var tvDetail: TextView
    private lateinit var tvFolder: TextView
    private lateinit var tvOverlay: TextView
    private lateinit var tvArrived: TextView
    private lateinit var tvPlayed: TextView
    private lateinit var tvQueue: TextView
    private lateinit var tvSkipped: TextView
    private var tvHomeConn: TextView? = null

    // ───────────────────────── Settings ─────────────────────────

    private val prefs by lazy { getSharedPreferences("waiptv", Context.MODE_PRIVATE) }
    private var themeIdx = 0
    private var accentIdx = 0
    private var bufferSize = 5
    private var resizeIdx = 1
    private lateinit var p: Palette
    private var accent = 0

    // ───────────────────────── State ─────────────────────────

    private val ui = Handler(Looper.getMainLooper())
    private val exec = Executors.newSingleThreadScheduledExecutor()

    private var screen = 0   // 0 = بيت الغرف، 1 = المشغّل
    private var selectedSectionId: String = WatchStore.INBOX_ID
    private var openRoomId: String? = null

    /** الأجزاء الواصلة وغير المُمرَّرة للمشغّل بعد، مرتبة حسب الرقم */
    private val pending = TreeMap<Long, Seg>()
    /** أسماء ملفات أجزاء الغرفة المفتوحة المعروفة للمشغّل (لمنع التكرار عند الإلحاق الحي) */
    private val knownFiles = HashSet<String>()

    private var watching = false
    private var initialized = false
    private var strict = false
    private var nextSeq = 0L
    private var gapSince = 0L
    private var lastArrival = 0L
    private var neededBuffer = 5
    private var isBufferReady = false
    /** لا تشغيل إطلاقاً قبل أن يضغط المستخدم بنفسه (زر البدء أو زر تشغيل المشغّل أو أمر !play) */
    private var userStarted = false
    private var isFullScreen = false
    private var resumeApplied = true

    private var arrived = 0
    private var skipped = 0

    private companion object {
        const val IDLE_START_MS = 6000L   // لو توقف الوصول، ابدأ بما لديك
        const val STALE_DROP_MS = 8000L   // جزء متأخر جداً يُهمل من قائمة الانتظار فقط (لا يُحذف ملفه أبداً)
        const val STALE_RESTART = 5       // عدد أجزاء قديمة دفعة واحدة = إعادة ترقيم البث
    }

    // ───────────────────────── Lifecycle ─────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        supportActionBar?.hide()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        themeIdx = Prefs.theme.value.coerceIn(0, palettes.size - 1)
        accentIdx = Prefs.accent.value.coerceIn(0, accents.size - 1)
        bufferSize = prefs.getInt("buf", 5)
        resizeIdx = prefs.getInt("resize", 1).coerceIn(0, resizeModes.size - 1)
        neededBuffer = bufferSize
        p = palettes[themeIdx]
        accent = accents[accentIdx]

        // مخزن الغرف جاهز من App — وهنا أيضاً لضمان العمل عند الدخول المباشر
        WatchStore.init(applicationContext)
        WatchStore.runExpiryCheck()

        player = ExoPlayer.Builder(this).build().apply {
            playWhenReady = false
            repeatMode = Player.REPEAT_MODE_OFF
        }
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                ui.post { persistResume(); updateStatus() }
            }

            // ضغط المستخدم زر التشغيل في واجهة المشغّل نفسه = إذن صريح بالبدء
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (playWhenReady && !userStarted) {
                    userStarted = true
                    ui.post { updateStatus() }
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && watching && initialized) {
                    ui.post { handleUnderrun() }
                }
                updateStatus()
            }

            override fun onPlayerError(error: PlaybackException) {
                ui.post { handleBrokenItem() }
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    isFullScreen -> toggleFullScreen()
                    screen == 1 -> backToHome()
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })

        // وضع المشاهدة: الأجزاء تذهب إلى WatchStore (مسجّل لعمر التطبيق في App)
        Repo.setMode("watch")
        Repo.chatCmdListener = { cmd, arg -> ui.post { if (screen == 1) onChatCmd(cmd, arg) } }
        WatchStore.changeListener = { ui.post { if (screen == 0) showHome() } }
        WatchStore.partListener = { part -> ui.post { onStorePart(part) } }

        showHome()
        ui.post(homeTick)
    }

    override fun onPause() {
        super.onPause()
        persistResume()
    }

    override fun onDestroy() {
        watching = false
        persistResume()
        // لا نلمس Repo.watchListener: يملكه WatchStore لعمر التطبيق
        Repo.chatCmdListener = null
        WatchStore.changeListener = null
        WatchStore.partListener = null
        ui.removeCallbacksAndMessages(null)
        exec.shutdown()
        player.release()
        super.onDestroy()
    }

    private val homeTick = object : Runnable {
        override fun run() {
            if (screen == 0) tvHomeConn?.text = connLabel()
            ui.postDelayed(this, 3000)
        }
    }

    // ───────────────────────── Rooms home ─────────────────────────

    private fun showHome() {
        screen = 0
        watching = false
        ui.removeCallbacks(tick)
        if (::player.isInitialized) {
            player.stop()
            player.clearMediaItems()
        }
        openRoomId = null
        pending.clear()
        knownFiles.clear()
        WatchStore.runExpiryCheck()
        if (selectedSectionId != WatchStore.FAVORITES_ID &&
            WatchStore.sections.value.none { it.id == selectedSectionId }
        ) selectedSectionId = WatchStore.INBOX_ID
        applyWindowTheme()
        setContentView(buildHomeUi())
    }

    private fun applyWindowTheme() {
        p = palettes[themeIdx]
        accent = accents[accentIdx]
        window.statusBarColor = p.bg
        window.navigationBarColor = p.bg
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !p.dark
            isAppearanceLightNavigationBars = !p.dark
        }
    }

    private fun refreshUi() {
        applyWindowTheme()
        if (::playerView.isInitialized) try { playerView.player = null } catch (_: Exception) {}
        if (screen == 1) {
            setContentView(buildPlayerUi())
            updateStatus()
        } else {
            showHome()
        }
    }

    private fun buildHomeUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(p.bg)
            fitsSystemWindows = true
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }

        // Header
        val titleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(label("WA Hub 3", 22f, p.text, true))
            addView(label("غرف المشاهدة — أجزاؤك محفوظة دائماً", 12f, p.sub, false))
        }
        tvHomeConn = label(connLabel(), 12f, p.sub, false)
        col.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(titleCol, LinearLayout.LayoutParams(0, WRAP, 1f))
            addView(tvHomeConn, LinearLayout.LayoutParams(WRAP, WRAP))
        }, lpx(MATCH, WRAP, b = 12))

        // Sections chips
        val sections = WatchStore.allSectionsForDisplay()
        val chipBox = LinearLayout(this)
        for (sec in sections) {
            val count = WatchStore.sectionRooms(sec.id).size
            val t = TextView(this).apply {
                text = "${sec.name} ($count)"
                textSize = 13f
                setPadding(dp(14), dp(8), dp(14), dp(8))
                val on = sec.id == selectedSectionId
                setTextColor(if (on) Color.WHITE else p.sub)
                background = rounded(if (on) accent else p.surface2, 20)
                setOnClickListener { selectedSectionId = sec.id; showHome() }
                setOnLongClickListener {
                    if (!sec.builtin) { sectionMenu(sec); true } else false
                }
            }
            chipBox.addView(t, lpx(WRAP, WRAP, e = 8))
        }
        col.addView(HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(chipBox)
        }, lpx(MATCH, WRAP, b = 10))

        // Section actions row
        val selSec = sections.firstOrNull { it.id == selectedSectionId }
        col.addView(rowOf(
            btn("➕ قسم جديد", accent, Color.WHITE) { createSectionDialog() },
            btn("➕ غرفة جديدة", p.surface2, p.text) { createRoomDialog() }
        ), lpx(MATCH, WRAP, b = 8))
        if (selSec != null && !selSec.builtin) {
            col.addView(
                btn("⋮ إجراءات القسم «${selSec.name}»", p.surface2, p.text) { sectionMenu(selSec) },
                lpx(MATCH, WRAP, b = 8)
            )
        }
        if (selSec != null) {
            val sizeTxt = fmtSize(WatchStore.sectionSize(selSec.id))
            col.addView(label("${selSec.name} — ${WatchStore.sectionRooms(selSec.id).size} غرفة • $sizeTxt", 12f, p.sub, false),
                lpx(MATCH, WRAP, b = 10))
        }

        // Rooms list
        val listCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val roomList = WatchStore.sectionRooms(selectedSectionId)
            .sortedWith(compareByDescending<WatchRoom> { it.receiving }.thenByDescending { it.createdAt })
        if (roomList.isEmpty()) {
            listCol.addView(card().apply {
                addView(label(
                    if (selectedSectionId == WatchStore.FAVORITES_ID) "لا غرف مفضلة بعد — نجّم غرفة لتظهر هنا."
                    else "لا غرف هنا بعد. الأجزاء الواصلة تُجمَّع تلقائياً في «غير مصنّف»، أو أنشئ غرفة واجعلها تستقبل.",
                    13f, p.sub, false
                ))
            })
        }
        roomList.forEach { room -> listCol.addView(roomCard(room)) }
        col.addView(listCol)

        col.addView(card().apply {
            addView(btn("🔀  تغيير الوضع", p.surface2, p.text) { switchMode() })
        })

        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(col, LinearLayout.LayoutParams(MATCH, WRAP))
        }
        root.addView(scroll, LinearLayout.LayoutParams(MATCH, MATCH))
        return root
    }

    private fun roomCard(room: WatchRoom): View {
        val partsCount = WatchStore.roomParts(room.id).size
        val size = WatchStore.roomSize(room.id)
        val remaining = WatchStore.remainingGraceMs(room)
        val status = when {
            room.receiving -> "يستقبل الآن"
            room.completedAt != null && room.favorite -> "مكتملة ⭐ محفوظة"
            room.completedAt != null -> "مكتملة — تُحذف بعد ${fmtRemaining(remaining ?: 0)}"
            else -> "جاهز"
        }
        val statusColor = when {
            room.receiving -> c("#22C55E")
            room.completedAt != null && !room.favorite -> c("#F59E0B")
            else -> p.sub
        }
        return card().apply {
            val head = LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(label(room.name, 16f, p.text, true), LinearLayout.LayoutParams(0, WRAP, 1f))
                addView(TextView(context).apply {
                    text = if (room.favorite) "★" else "☆"
                    textSize = 22f
                    setTextColor(if (room.favorite) c("#F59E0B") else p.sub)
                    setPadding(dp(8), dp(2), dp(8), dp(2))
                    setOnClickListener {
                        WatchStore.setFavorite(room.id, !room.favorite)
                        showHome()
                    }
                })
                addView(TextView(context).apply {
                    text = "⋮"
                    textSize = 20f
                    setTextColor(p.sub)
                    setPadding(dp(8), dp(2), dp(8), dp(2))
                    setOnClickListener { roomMenu(room) }
                })
            }
            addView(head)
            addView(label("$partsCount أجزاء • ${fmtSize(size)}", 12f, p.sub, false), lpx(MATCH, WRAP, t = 4))
            addView(label(status, 12f, statusColor, true), lpx(MATCH, WRAP, t = 2))
            if (room.resumePartIndex > 0 || room.resumePositionMs > 0) {
                addView(label("▶ متابعة من الجزء ${room.resumePartIndex + 1}", 12f, accent, false), lpx(MATCH, WRAP, t = 2))
            }
            if (room.completedAt != null && !room.favorite) {
                addView(btn("↩ تراجع عن الإكمال", p.surface2, p.text) {
                    WatchStore.setCompleted(room.id, false)
                    showHome()
                }, lpx(MATCH, WRAP, t = 8))
            }
            addView(btn("▶  مشاهدة", accent, Color.WHITE) { openRoom(room.id) }, lpx(MATCH, WRAP, t = 8))
        }
    }

    // ───────────────────────── Dialogs & actions ─────────────────────────

    private fun inputDialog(title: String, initial: String, hint: String, onOk: (String) -> Unit) {
        val et = EditText(this).apply {
            setText(initial)
            this.hint = hint
            setSingleLine(true)
        }
        AlertDialog.Builder(this)
            .setTitle(title)
            .setView(et)
            .setPositiveButton("حفظ") { _, _ -> onOk(et.text.toString()) }
            .setNegativeButton("إلغاء", null)
            .show()
    }

    private fun createSectionDialog() {
        inputDialog("قسم جديد", "", "اسم القسم") { name ->
            if (name.isBlank()) return@inputDialog
            val s = WatchStore.createSection(name)
            selectedSectionId = s.id
            showHome()
        }
    }

    private fun sectionMenu(sec: WatchSection) {
        if (sec.builtin) return
        val labels = arrayOf("إعادة تسمية", "حذف القسم")
        AlertDialog.Builder(this)
            .setTitle(sec.name)
            .setItems(labels) { _, which ->
                when (which) {
                    0 -> inputDialog("إعادة تسمية القسم", sec.name, "الاسم الجديد") { name ->
                        WatchStore.renameSection(sec.id, name)
                        showHome()
                    }
                    1 -> AlertDialog.Builder(this)
                        .setTitle("حذف القسم؟")
                        .setMessage("لن تُحذف الغرف: ستنتقل إلى «غير مصنّف».")
                        .setPositiveButton("حذف") { _, _ ->
                            WatchStore.deleteSection(sec.id)
                            if (selectedSectionId == sec.id) selectedSectionId = WatchStore.INBOX_ID
                            showHome()
                        }
                        .setNegativeButton("إلغاء", null)
                        .show()
                }
            }
            .show()
    }

    private fun createRoomDialog() {
        val realSections = WatchStore.sections.value
        var chosenSection = if (selectedSectionId == WatchStore.FAVORITES_ID) WatchStore.INBOX_ID else selectedSectionId
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), dp(4))
        }
        val et = EditText(this).apply {
            hint = "اسم الغرفة"
            setSingleLine(true)
        }
        box.addView(et)
        val secBtn = TextView(this).apply {
            textSize = 14f
            setTextColor(p.text)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            fun refreshLabel() {
                val n = realSections.firstOrNull { it.id == chosenSection }?.name ?: "غير مصنّف"
                text = "القسم: $n  ▾"
            }
            refreshLabel()
            setOnClickListener {
                AlertDialog.Builder(this@WatchActivity)
                    .setTitle("اختر القسم")
                    .setItems(realSections.map { it.name }.toTypedArray()) { _, w ->
                        chosenSection = realSections[w].id
                        refreshLabel()
                    }
                    .show()
            }
        }
        box.addView(secBtn)
        val cb = CheckBox(this).apply {
            text = "استقبال هنا (الأجزاء الجديدة تذهب لهذه الغرفة)"
            setTextColor(p.text)
        }
        box.addView(cb)
        AlertDialog.Builder(this)
            .setTitle("غرفة جديدة")
            .setView(box)
            .setPositiveButton("إنشاء") { _, _ ->
                val name = et.text.toString()
                if (name.isBlank()) { toast("أدخل اسم الغرفة"); return@setPositiveButton }
                WatchStore.createRoom(name, chosenSection, cb.isChecked)
                selectedSectionId = chosenSection
                showHome()
            }
            .setNegativeButton("إلغاء", null)
            .show()
    }

    private fun roomMenu(room: WatchRoom) {
        val actions = ArrayList<Pair<String, () -> Unit>>()
        actions.add("مشاهدة" to { openRoom(room.id) })
        actions.add((if (room.favorite) "إلغاء المفضلة" else "⭐ مفضلة") to {
            WatchStore.setFavorite(room.id, !room.favorite); showHome()
        })
        actions.add("نقل إلى قسم" to { moveRoomDialog(room) })
        actions.add("إعادة تسمية" to {
            inputDialog("إعادة تسمية الغرفة", room.name, "الاسم الجديد") { name ->
                WatchStore.renameRoom(room.id, name); showHome()
            }
        })
        actions.add((if (room.receiving) "إيقاف الاستقبال" else "استقبال هنا") to {
            WatchStore.setReceiving(if (room.receiving) null else room.id); showHome()
        })
        actions.add((if (room.completedAt != null) "تراجع عن الإكمال" else "✓ أكملت الغرفة") to {
            WatchStore.setCompleted(room.id, room.completedAt == null); showHome()
        })
        actions.add("حذف الغرفة" to {
            AlertDialog.Builder(this)
                .setTitle("حذف الغرفة؟")
                .setMessage("ستُحذف «${room.name}» وكل أجزائها (${WatchStore.roomParts(room.id).size} أجزاء، ${fmtSize(WatchStore.roomSize(room.id))}) نهائياً.")
                .setPositiveButton("حذف") { _, _ ->
                    WatchStore.deleteRoom(room.id)
                    showHome()
                }
                .setNegativeButton("إلغاء", null)
                .show()
        })
        AlertDialog.Builder(this)
            .setTitle(room.name)
            .setItems(actions.map { it.first }.toTypedArray()) { _, w -> actions[w].second() }
            .show()
    }

    private fun moveRoomDialog(room: WatchRoom) {
        val secs = WatchStore.sections.value
        AlertDialog.Builder(this)
            .setTitle("نقل «${room.name}» إلى…")
            .setItems(secs.map { it.name }.toTypedArray()) { _, w ->
                WatchStore.moveRoom(room.id, secs[w].id)
                showHome()
            }
            .show()
    }

    // ───────────────────────── Room player: open / close ─────────────────────────

    private fun openRoom(roomId: String) {
        val room = WatchStore.room(roomId) ?: return
        screen = 1
        openRoomId = roomId
        ui.removeCallbacks(tick)

        player.stop()
        player.clearMediaItems()
        player.playWhenReady = false
        pending.clear()
        knownFiles.clear()
        arrived = 0; skipped = 0
        initialized = false
        isBufferReady = false
        userStarted = false
        gapSince = 0L
        nextSeq = 0L
        neededBuffer = bufferSize
        resumeApplied = room.resumePartIndex <= 0 && room.resumePositionMs <= 0L
        lastArrival = SystemClock.elapsedRealtime()
        watching = true

        applyWindowTheme()
        setContentView(buildPlayerUi())

        val segs = WatchStore.roomParts(roomId).map { part -> partToSeg(part) }
        onSegments(segs)
        ui.post(tick)
        updateStatus()
    }

    private fun backToHome() {
        persistResume()
        watching = false
        ui.removeCallbacks(tick)
        player.stop()
        player.clearMediaItems()
        showHome()
    }

    private fun partToSeg(part: WatchPart): Seg {
        val f = File(WatchStore.roomDir(part.roomId), part.fileName)
        val strictSeg = part.orderKey < 1_000_000_000L
        return Seg(Uri.fromFile(f), part.name, part.orderKey, strictSeg, part.fileName)
    }

    /** جزء جديد خزّنه WatchStore: إن كان لغرفتنا المفتوحة يُلحق حياً بقائمة التشغيل */
    private fun onStorePart(part: WatchPart) {
        if (screen != 1 || part.roomId != openRoomId) return
        if (part.fileName in knownFiles) return
        onSegments(listOf(partToSeg(part)))
    }

    /** أوامر مكتوبة في الشات: !pause !play !next !fs !speed !vol — تتحكم بالغرفة المفتوحة */
    private fun onChatCmd(cmd: String, arg: Double?) {
        when (cmd) {
            "pause" -> player.playWhenReady = false
            "play" -> { userStarted = true; player.playWhenReady = true }
            "next" -> if (player.hasNextMediaItem()) player.seekToNextMediaItem()
            "fs" -> toggleFullScreen()
            "speed" -> if (arg != null) player.setPlaybackSpeed(arg.toFloat().coerceIn(0.25f, 4f))
            "vol" -> if (arg != null) player.volume = (arg.toFloat() / 100f).coerceIn(0f, 1f)
        }
    }

    // ───────────────────────── Player engine ─────────────────────────

    private val tick = object : Runnable {
        override fun run() {
            if (!watching || screen != 1) return
            val now = SystemClock.elapsedRealtime()
            if (!initialized && pending.isNotEmpty() && now - lastArrival > IDLE_START_MS) initialize()
            pump()
            if (initialized && !isBufferReady && player.mediaItemCount > 0 &&
                now - lastArrival > IDLE_START_MS
            ) startPlayback()
            persistResume()
            updateStatus()
            ui.postDelayed(this, 1000)
        }
    }

    private fun onSegments(list: List<Seg>) {
        if (!watching || screen != 1) return
        val now = SystemClock.elapsedRealtime()
        for (s in list) {
            if (!knownFiles.add(s.fileName)) continue   // معروف سلفاً
            s.arrivedAt = now
            var k = s.key
            if (s.strict) {
                if (pending.containsKey(k)) continue // نفس الرقم مرتين = تكرار
            } else {
                while (pending.containsKey(k)) k++
            }
            pending[k] = s
            arrived++
        }
        lastArrival = now
        if (!initialized && pending.size >= bufferSize) initialize()
        pump()
        updateStatus()
    }

    /** يحدد نقطة البداية بعد تجميع عدد كافٍ ليُرتَّب البدء صحيحاً (1 ثم 2 ثم ... 10) */
    private fun initialize() {
        initialized = true
        strict = pending.values.all { it.strict }
        nextSeq = if (strict && pending.isNotEmpty()) pending.firstKey() else 0L
        neededBuffer = bufferSize
        isBufferReady = false
        gapSince = 0L
    }

    /**
     * يمرّر للمشغّل فقط الجزء التالي بالترتيب.
     * إن غاب جزء: ينتظر وصوله للأبد (بلا مهلة) بدل القفز — وملف الجزء المتأخر لا يُحذف أبداً.
     */
    private fun pump() {
        if (!initialized) return
        val now = SystemClock.elapsedRealtime()

        if (!strict) {
            while (pending.isNotEmpty()) feed(pending.pollFirstEntry()!!.value)
            return
        }

        // أجزاء قديمة (أصغر من المتوقع): تُهمل من الانتظار فقط إن تأخرت كثيراً، أو البث أعاد الترقيم
        val stale = pending.headMap(nextSeq)
        if (stale.size >= STALE_RESTART) {
            nextSeq = pending.firstKey()
            gapSince = 0L
        } else if (stale.isNotEmpty()) {
            val it = stale.entries.iterator()
            while (it.hasNext()) if (now - it.next().value.arrivedAt > STALE_DROP_MS) it.remove()
        }

        while (true) {
            val e = pending.ceilingEntry(nextSeq) ?: break
            if (e.key == nextSeq) {
                pending.remove(e.key)
                feed(e.value)
                nextSeq++
                gapSince = 0L
            } else {
                // فجوة: الجزء nextSeq لم يصل بعد — انتظار بلا نهاية
                if (gapSince == 0L) gapSince = now
                break
            }
        }
        if (pending.ceilingEntry(nextSeq) == null) gapSince = 0L
    }

    private fun feed(s: Seg) {
        player.addMediaItem(
            MediaItem.Builder().setUri(s.uri).setMediaId(s.uri.toString()).build()
        )
        when (player.playbackState) {
            Player.STATE_IDLE -> player.prepare()
            Player.STATE_ENDED -> player.seekToDefaultPosition(player.mediaItemCount - 1)
            else -> {}
        }
        // استئناف موضع المشاهدة المحفوظ للغرفة (مرة واحدة)
        if (!resumeApplied) {
            val room = openRoomId?.let { WatchStore.room(it) }
            if (room != null && player.mediaItemCount > room.resumePartIndex) {
                player.seekTo(room.resumePartIndex, room.resumePositionMs)
                resumeApplied = true
            } else if (room != null && room.resumePartIndex <= 0) {
                resumeApplied = true
            }
        }
        if (!isBufferReady && player.mediaItemCount >= neededBuffer) startPlayback()
    }

    private fun startPlayback() {
        isBufferReady = true
        if (player.playbackState == Player.STATE_IDLE) player.prepare()
        // لا صوت ولا تشغيل من تلقاء نفسه: البدء الفعلي بضغطة المستخدم فقط.
        // بعد أن يبدأ مرة، الاستئناف التلقائي بعد النفاد مسموح ومطلوب.
        if (userStarted) player.playWhenReady = true
        updateStatus()
    }

    /** نفدت الأجزاء: لا نقطع ولا نحذف شيئاً، نوقف مؤقتاً وننتظر أجزاء جديدة ثم نكمل */
    private fun handleUnderrun() {
        if (!watching || !initialized) return
        if (player.mediaItemCount == 0) return
        player.playWhenReady = false
        isBufferReady = false
        neededBuffer = bufferSize   // انتظار المخزون الكامل قبل الاستئناف: لا دورات توقف/تشغيل متكررة
        persistResume()
        pump()
        updateStatus()
    }

    private fun handleBrokenItem() {
        val idx = player.currentMediaItemIndex
        if (idx in 0 until player.mediaItemCount) {
            player.removeMediaItem(idx)   // يُزال من قائمة التشغيل فقط — الملف يبقى في الغرفة
            skipped++
            toast("تم تخطي جزء تالف (ملفه محفوظ في الغرفة)")
        }
        if (player.mediaItemCount == 0) {
            isBufferReady = false
            neededBuffer = bufferSize   // انتظار المخزون الكامل قبل الاستئناف
            player.playWhenReady = false
        } else {
            player.playWhenReady = isBufferReady && userStarted
        }
        player.prepare()
        updateStatus()
    }

    /** حفظ موضع الاستئناف للغرفة المفتوحة (رقم الجزء + الموضع) */
    private fun persistResume() {
        val roomId = openRoomId ?: return
        if (screen != 1 || !::player.isInitialized) return
        if (player.mediaItemCount == 0) return
        try {
            WatchStore.updateResume(
                roomId,
                player.currentMediaItemIndex.coerceAtLeast(0),
                player.currentPosition.coerceAtLeast(0)
            )
        } catch (_: Exception) {}
    }

    // ───────────────────────── Status ─────────────────────────

    private fun connLabel(): String = when (Repo.conn.value) {
        "open" -> "واتساب: متصل ✓"
        "connecting", "idle" -> "واتساب: جارٍ الاتصال…"
        "reconnecting" -> "واتساب: إعادة الاتصال…"
        "replaced" -> "واتساب: فُتحت جلسة أخرى بنفس الحساب"
        else -> "واتساب: غير مسجّل"
    }

    private fun updateStatus() {
        if (!::tvFolder.isInitialized || screen != 1) return
        val room = openRoomId?.let { WatchStore.room(it) }
        tvFolder.text = "الغرفة: ${room?.name ?: "—"}\n${connLabel()}"
        if (!::tvStatus.isInitialized) return
        val now = SystemClock.elapsedRealtime()
        val green = c("#22C55E")
        val warn = c("#F59E0B")

        tvArrived.text = arrived.toString()
        tvPlayed.text = (if (::player.isInitialized) player.currentMediaItemIndex else 0).toString()
        tvQueue.text = (player.mediaItemCount + pending.size).toString()
        tvSkipped.text = skipped.toString()

        var detail = ""
        val (text, color) = when {
            !watching -> "متوقف" to p.sub
            !initialized -> "⏳ تجميع ${pending.size}/$bufferSize" to warn
            gapSince != 0L -> {
                val waited = (now - gapSince) / 1000
                detail = "ينتظر الجزء #$nextSeq منذ ${waited}ث (بلا مهلة — لن يتخطّاه)"
                "⏳ بانتظار جزء" to warn
            }
            !isBufferReady -> "⏳ تخزين ${player.mediaItemCount}/$neededBuffer" to warn
            !userStarted -> "⏸ جاهز — اضغط ابدأ المشاهدة" to warn
            else -> "▶ يعمل" to green
        }
        if (detail.isEmpty() && watching && initialized && strict) detail = "التالي المتوقع: #$nextSeq"
        tvStatus.text = text
        tvStatus.setTextColor(color)
        tvStatus.background = rounded(ColorUtils.setAlphaComponent(color, 40), 20)
        tvDetail.text = detail

        val readyWaiting = watching && initialized && isBufferReady && !userStarted
        val waiting = watching && initialized && (gapSince != 0L || !isBufferReady || readyWaiting)
        tvOverlay.visibility = if (waiting) View.VISIBLE else View.GONE
        tvOverlay.text = when {
            gapSince != 0L -> "⏳ بانتظار الجزء #$nextSeq…"
            readyWaiting -> "⏸ جاهز — اضغط ابدأ المشاهدة"
            else -> "⏳ جاري التخزين المؤقت…"
        }
    }

    // ───────────────────────── Player UI building ─────────────────────────

    private val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
    private val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun rounded(color: Int, r: Int) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(r).toFloat()
    }

    private fun lpx(w: Int, h: Int, t: Int = 0, b: Int = 0, s: Int = 0, e: Int = 0) =
        LinearLayout.LayoutParams(w, h).apply {
            setMargins(0, dp(t), 0, dp(b)); marginStart = dp(s); marginEnd = dp(e)
        }

    private fun playerHeight(): Int {
        val m = resources.displayMetrics
        return minOf(m.widthPixels * 9 / 16, (m.heightPixels * 0.5f).toInt())
    }

    private fun buildPlayerUi(): View {
        val room = openRoomId?.let { WatchStore.room(it) }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(p.bg)
            fitsSystemWindows = true
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }

        // ── Player ──
        playerContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            layoutDirection = View.LAYOUT_DIRECTION_LTR
        }
        playerView = PlayerView(this).apply {
            this.player = this@WatchActivity.player
            setBackgroundColor(Color.BLACK)
            resizeMode = resizeModes[resizeIdx].first
            setKeepContentOnPlayerReset(true)
            setShowNextButton(false)
            setShowPreviousButton(false)
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            setFullscreenButtonClickListener { toggleFullScreen() }
        }
        tvOverlay = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 13f
            setPadding(dp(14), dp(8), dp(14), dp(8))
            background = rounded(0xAA000000.toInt(), 20)
            visibility = View.GONE
        }
        playerContainer.addView(playerView, FrameLayout.LayoutParams(MATCH, MATCH))
        playerContainer.addView(
            tvOverlay,
            FrameLayout.LayoutParams(WRAP, WRAP, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
                .apply { topMargin = dp(12) }
        )
        val ph = if (isFullScreen) MATCH else playerHeight()
        root.addView(playerContainer, LinearLayout.LayoutParams(MATCH, ph))

        // ── Controls ──
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }

        // Header
        val titleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(label(room?.name ?: "غرفة المشاهدة", 20f, p.text, true))
            addView(label("أجزاء الغرفة محفوظة — لا حذف ولا دمج", 12f, p.sub, false))
        }
        tvStatus = TextView(this).apply {
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(14), dp(7), dp(14), dp(7))
        }
        col.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(titleCol, LinearLayout.LayoutParams(0, WRAP, 1f))
            addView(tvStatus, LinearLayout.LayoutParams(WRAP, WRAP))
        }, lpx(MATCH, WRAP, b = 14))

        // Stats
        val (t1, v1) = tile("وصل"); tvArrived = v1
        val (t2, v2) = tile("الحالي"); tvPlayed = v2
        val (t3, v3) = tile("بالطابور"); tvQueue = v3
        val (t4, v4) = tile("تخطّي"); tvSkipped = v4
        tvDetail = label("", 12f, p.sub, false).apply { gravity = Gravity.CENTER }
        col.addView(card().apply {
            addView(rowOf(t1, t2, t3, t4))
            addView(tvDetail, lpx(MATCH, WRAP, t = 10))
        })

        // البدء الصريح: لا يبدأ أي تشغيل قبل ضغطة المستخدم هنا (أو زر تشغيل المشغّل)
        col.addView(
            btn("▶  ابدأ المشاهدة", accent, Color.WHITE) {
                userStarted = true
                startPlayback()
            },
            lpx(MATCH, WRAP, b = 12)
        )

        col.addView(
            btn("⬅  كل الغرف", p.surface2, p.text) { backToHome() },
            lpx(MATCH, WRAP, b = 12)
        )

        // المصدر: الغرفة + واتساب
        tvFolder = label("", 13f, p.sub, false)
        col.addView(card().apply {
            addView(title("المصدر"))
            addView(tvFolder)
            addView(label("الأجزاء الجديدة لهذه الغرفة (إن كانت تستقبل، أو باسمها) تُلحق بالمشاهدة حياً. أوامر الشات: !play !pause !next !fs !speed !vol", 12f, p.sub, false), lpx(MATCH, WRAP, t = 6))
        })

        // Playback
        col.addView(card().apply {
            addView(title("التشغيل"))

            addView(label("حجم التخزين المؤقت قبل البدء (أجزاء)", 13f, p.sub, false), lpx(MATCH, WRAP, b = 6))
            addView(
                chips(bufferOptions.map { "$it" }, bufferOptions.indexOf(bufferSize).coerceAtLeast(0)) {
                    bufferSize = bufferOptions[it]
                    neededBuffer = bufferSize
                    prefs.edit().putInt("buf", bufferSize).apply()
                }, lpx(MATCH, WRAP, b = 14)
            )

            addView(label("مهلة انتظار الجزء الغائب", 13f, p.sub, false), lpx(MATCH, WRAP, b = 2))
            addView(
                label("∞ دائماً — المشغّل يتوقف وينتظر وصول الجزء بدل القفز، ولا يحذف أي جزء.", 11f, p.sub, false),
                lpx(MATCH, WRAP, b = 14)
            )

            addView(label("أبعاد الفيديو", 13f, p.sub, false), lpx(MATCH, WRAP, b = 6))
            addView(
                chips(resizeModes.map { it.second }, resizeIdx) {
                    resizeIdx = it
                    playerView.resizeMode = resizeModes[it].first
                    prefs.edit().putInt("resize", it).apply()
                }, lpx(MATCH, WRAP, b = 14)
            )

            addView(btn("⛶  ملء الشاشة", p.surface2, p.text) { toggleFullScreen() })
        })

        // Theme — نفس اختيار Prefs.theme المشترك مع بقية التطبيق
        col.addView(card().apply {
            addView(title("المظهر"))
            addView(
                chips(palettes.map { it.name }, themeIdx) {
                    themeIdx = it
                    Prefs.set(Prefs.theme, "theme", it)
                    ui.post { refreshUi() }
                }, lpx(MATCH, WRAP, b = 14)
            )
            addView(label("لون التمييز", 13f, p.sub, false), lpx(MATCH, WRAP, b = 8))
            addView(swatches())
        })

        // تغيير الوضع (يعود لشاشة الاختيار)
        col.addView(card().apply {
            addView(btn("🔀  تغيير الوضع", p.surface2, p.text) { switchMode() })
        })

        controlsLayout = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(col, LinearLayout.LayoutParams(MATCH, WRAP))
            visibility = if (isFullScreen) View.GONE else View.VISIBLE
        }
        root.addView(controlsLayout, LinearLayout.LayoutParams(MATCH, 0, 1f))
        return root
    }

    // ---- UI helpers ----

    private fun label(t: String, size: Float, color: Int, bold: Boolean) = TextView(this).apply {
        text = t; textSize = size; setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun title(t: String) = label(t, 15f, p.text, true).apply {
        layoutParams = lpx(MATCH, WRAP, b = 12)
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(p.surface, 20)
        setPadding(dp(16), dp(14), dp(16), dp(16))
        layoutParams = lpx(MATCH, WRAP, b = 12)
    }

    private fun tile(l: String): Pair<View, TextView> {
        val v = label("0", 20f, p.text, true).apply { gravity = Gravity.CENTER }
        val lab = label(l, 11f, p.sub, false).apply { gravity = Gravity.CENTER }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), dp(12), dp(4), dp(12))
            background = rounded(p.surface2, 14)
            addView(v); addView(lab)
        }
        return box to v
    }

    private fun rowOf(vararg views: View) = LinearLayout(this).apply {
        views.forEachIndexed { i, v ->
            addView(v, LinearLayout.LayoutParams(0, WRAP, 1f).apply {
                if (i > 0) marginStart = dp(8)
            })
        }
    }

    private fun btn(text: String, bg: Int, fg: Int, onClick: () -> Unit) = TextView(this).apply {
        this.text = text
        setTextColor(fg)
        textSize = 15f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        setPadding(dp(16), dp(14), dp(16), dp(14))
        background = RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), rounded(bg, 14), null)
        isClickable = true
        setOnClickListener { onClick() }
    }

    private fun chips(options: List<String>, selected: Int, onSelect: (Int) -> Unit): View {
        val box = LinearLayout(this)
        val views = ArrayList<TextView>()
        fun style(sel: Int) = views.forEachIndexed { i, t ->
            val on = i == sel
            t.setTextColor(if (on) Color.WHITE else p.sub)
            t.background = rounded(if (on) accent else p.surface2, 20)
        }
        options.forEachIndexed { i, l ->
            val t = TextView(this).apply {
                text = l; textSize = 13f
                setPadding(dp(14), dp(8), dp(14), dp(8))
                setOnClickListener { style(i); onSelect(i) }
            }
            views.add(t)
            box.addView(t, lpx(WRAP, WRAP, e = 8))
        }
        style(selected)
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(box)
        }
    }

    private fun swatches(): View {
        val box = LinearLayout(this)
        val views = ArrayList<TextView>()
        fun style(sel: Int) = views.forEachIndexed { i, t ->
            t.text = if (i == sel) "✓" else ""
        }
        accents.forEachIndexed { i, col ->
            val t = TextView(this).apply {
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
                typeface = Typeface.DEFAULT_BOLD
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(col) }
                setOnClickListener {
                    accentIdx = i
                    Prefs.set(Prefs.accent, "accent", i)
                    ui.post { refreshUi() }
                }
            }
            views.add(t)
            box.addView(t, lpx(dp(38), dp(38), e = 10).apply { width = dp(38); height = dp(38) })
        }
        style(accentIdx)
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(box)
        }
    }

    // ───────────────────────── Helpers & misc ─────────────────────────

    private fun fmtSize(b: Long): String = when {
        b >= 1L shl 30 -> String.format(java.util.Locale.US, "%.2f GB", b / 1073741824.0)
        b >= 1L shl 20 -> String.format(java.util.Locale.US, "%.1f MB", b / 1048576.0)
        b >= 1024 -> String.format(java.util.Locale.US, "%.0f KB", b / 1024.0)
        else -> "$b B"
    }

    private fun fmtRemaining(ms: Long): String {
        val totalMin = ms / 60000
        val h = totalMin / 60
        val m = totalMin % 60
        return if (h > 0) "${h}س ${m}د" else "${m}د"
    }

    private fun switchMode() {
        persistResume()
        watching = false
        ui.removeCallbacks(tick)
        player.stop()
        Repo.setMode(null)
        startActivity(Intent(this, LauncherActivity::class.java).putExtra("choose", true))
        finish()
    }

    private fun toggleFullScreen() {
        if (screen != 1 || !::playerContainer.isInitialized) return
        isFullScreen = !isFullScreen
        val params = playerContainer.layoutParams as LinearLayout.LayoutParams
        val ctrl = WindowInsetsControllerCompat(window, window.decorView)
        if (isFullScreen) {
            controlsLayout.visibility = View.GONE
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            params.height = ViewGroup.LayoutParams.MATCH_PARENT
            ctrl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            ctrl.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controlsLayout.visibility = View.VISIBLE
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            params.height = playerHeight()
            ctrl.show(WindowInsetsCompat.Type.systemBars())
        }
        playerContainer.layoutParams = params
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
