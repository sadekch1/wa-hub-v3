package com.example.wahub3.watch

import android.content.Context
import com.example.wahub3.Repo
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

// ───────────────────────── نماذج غرف المشاهدة ─────────────────────────

data class WatchSection(
    val id: String,
    val name: String,
    val builtin: Boolean = false
)

data class WatchRoom(
    val id: String,
    val name: String,
    val sectionId: String,
    val favorite: Boolean = false,
    val createdAt: Long = System.currentTimeMillis(),
    val completedAt: Long? = null,
    val receiving: Boolean = false,
    val resumePartIndex: Int = 0,
    val resumePositionMs: Long = 0L
)

data class WatchPart(
    val roomId: String,
    val fileName: String,      // اسم الملف داخل مجلد الغرفة
    val name: String,          // الاسم الأصلي المعروض
    val orderKey: Long,        // الرقم التسلسلي المستخرج (أو وقت الوصول عند غيابه)
    val size: Long,
    val arrivedAt: Long = System.currentTimeMillis()
)

/**
 * مخزن غرف المشاهدة الدائم.
 *
 * التخزين: files/rooms/<roomId>/ للأجزاء + files/rooms/rooms.json للفهرس.
 * يُهيَّأ مرة واحدة من App (سياق التطبيق) ويسجّل Repo.watchListener لعمر التطبيق
 * كله — لا يرتبط بـ WatchActivity: الأجزاء الواصلة تُحفظ حتى والتطبيق في وضع آخر.
 *
 * «المفضلة» (id=favorites) عرض افتراضي غير محفوظ: يجمع كل غرفة مفضلة من كل الأقسام.
 * «غير مصنّف» (id=inbox) قسم حقيقي افتراضي لا يُحذف.
 */
object WatchStore {

    const val FAVORITES_ID = "favorites"
    const val INBOX_ID = "inbox"
    const val GRACE_MS = 10L * 60 * 60 * 1000   // 10 ساعات بعد الإكمال

    val sections = MutableStateFlow<List<WatchSection>>(emptyList())
    val rooms = MutableStateFlow<List<WatchRoom>>(emptyList())
    val parts = MutableStateFlow<Map<String, List<WatchPart>>>(emptyMap())

    /** يُستدعى (على خيط الواجهة من المستمع) عند أي تغيير — لتحديث القوائم */
    @Volatile var changeListener: (() -> Unit)? = null
    /** يُستدعى عند وصول جزء جديد لغرفة ما — ليلتقطه المشغّل المفتوح على تلك الغرفة */
    @Volatile var partListener: ((WatchPart) -> Unit)? = null

    private lateinit var appCtx: Context
    private var inited = false
    private val exec = Executors.newSingleThreadExecutor()
    private val numRe = Regex("(\\d+)(?!.*\\d)")

    fun init(ctx: Context) {
        if (inited) return
        inited = true
        appCtx = ctx.applicationContext
        load()
        // استقبال دائم لعمر التطبيق: كل جزء مشاهدة يصل يصبح ملكاً للمخزن
        Repo.watchListener = { path, name -> onIncomingPart(path, name) }
    }

    // ───────────────────────── المسارات ─────────────────────────

    fun rootDir(): File = File(appCtx.filesDir, "rooms").apply { mkdirs() }
    fun roomDir(roomId: String): File = File(rootDir(), roomId).apply { mkdirs() }
    private fun indexFile(): File = File(rootDir(), "rooms.json")

    // ───────────────────────── الحفظ والتحميل ─────────────────────────

    @Synchronized
    private fun load() {
        var secs = listOf(WatchSection(INBOX_ID, "غير مصنّف", builtin = true))
        var rms: List<WatchRoom> = emptyList()
        var pts: Map<String, List<WatchPart>> = emptyMap()
        try {
            val f = indexFile()
            if (f.exists()) {
                val root = JSONObject(f.readText())
                val sa = root.optJSONArray("sections") ?: JSONArray()
                val parsed = ArrayList<WatchSection>()
                for (i in 0 until sa.length()) {
                    val o = sa.getJSONObject(i)
                    parsed.add(WatchSection(o.getString("id"), o.getString("name"), o.optBoolean("builtin")))
                }
                if (parsed.none { it.id == INBOX_ID }) parsed.add(0, WatchSection(INBOX_ID, "غير مصنّف", true))
                secs = parsed
                val ra = root.optJSONArray("rooms") ?: JSONArray()
                rms = (0 until ra.length()).map {
                    val o = ra.getJSONObject(it)
                    WatchRoom(
                        id = o.getString("id"),
                        name = o.getString("name"),
                        sectionId = o.optString("sectionId", INBOX_ID),
                        favorite = o.optBoolean("favorite"),
                        createdAt = o.optLong("createdAt"),
                        completedAt = if (o.isNull("completedAt")) null else o.optLong("completedAt"),
                        receiving = o.optBoolean("receiving"),
                        resumePartIndex = o.optInt("resumePartIndex"),
                        resumePositionMs = o.optLong("resumePositionMs")
                    )
                }
                // غرفة واحدة فقط تستقبل
                if (rms.count { it.receiving } > 1) {
                    var kept = false
                    rms = rms.map { r ->
                        if (r.receiving && kept) r.copy(receiving = false) else { if (r.receiving) kept = true; r }
                    }
                }
                val pa = root.optJSONArray("parts") ?: JSONArray()
                val byRoom = HashMap<String, MutableList<WatchPart>>()
                for (i in 0 until pa.length()) {
                    val o = pa.getJSONObject(i)
                    val part = WatchPart(
                        roomId = o.getString("roomId"),
                        fileName = o.getString("file"),
                        name = o.getString("name"),
                        orderKey = o.optLong("orderKey"),
                        size = o.optLong("size"),
                        arrivedAt = o.optLong("arrivedAt")
                    )
                    // تجاهل أجزاء اختفت ملفاتها من القرص
                    if (File(roomDir(part.roomId), part.fileName).exists())
                        byRoom.getOrPut(part.roomId) { ArrayList() }.add(part)
                }
                pts = byRoom.mapValues { (_, l) -> sortParts(l) }
            }
        } catch (_: Exception) {}
        sections.value = secs
        rooms.value = rms
        parts.value = pts
    }

    private fun sortParts(l: List<WatchPart>): List<WatchPart> =
        l.sortedWith(compareBy({ it.orderKey }, { it.arrivedAt }))

    /** حفظ الفهرس على خيط خلفي — لا يلمس خيط الواجهة */
    private fun persist() {
        exec.execute {
            try {
                val root = JSONObject()
                val sa = JSONArray()
                sections.value.forEach { s ->
                    sa.put(JSONObject().put("id", s.id).put("name", s.name).put("builtin", s.builtin))
                }
                root.put("sections", sa)
                val ra = JSONArray()
                rooms.value.forEach { r ->
                    ra.put(
                        JSONObject().put("id", r.id).put("name", r.name).put("sectionId", r.sectionId)
                            .put("favorite", r.favorite).put("createdAt", r.createdAt)
                            .put("completedAt", r.completedAt ?: JSONObject.NULL)
                            .put("receiving", r.receiving)
                            .put("resumePartIndex", r.resumePartIndex)
                            .put("resumePositionMs", r.resumePositionMs)
                    )
                }
                root.put("rooms", ra)
                val pa = JSONArray()
                parts.value.values.flatten().forEach { p ->
                    pa.put(
                        JSONObject().put("roomId", p.roomId).put("file", p.fileName).put("name", p.name)
                            .put("orderKey", p.orderKey).put("size", p.size).put("arrivedAt", p.arrivedAt)
                    )
                }
                root.put("parts", pa)
                val tmp = File(rootDir(), "rooms.json.tmp")
                tmp.writeText(root.toString())
                tmp.renameTo(indexFile())
            } catch (_: Exception) {}
        }
    }

    private fun changed() {
        persist()
        try { changeListener?.invoke() } catch (_: Exception) {}
    }

    // ───────────────────────── استقبال الأجزاء ─────────────────────────

    /** (الاسم الأساسي، الرقم) — يعيد الرقم المستخرج من آخر stem الاسم مثل WatchActivity */
    fun parseBase(name: String): Pair<String, Long?> {
        // نمط movie.001 : الامتداد نفسه رقم الجزء
        val dotNum = Regex("^(.+)\\.(\\d{2,4})$").matchEntire(name)
        if (dotNum != null) {
            val n = dotNum.groupValues[2].toLongOrNull()
            if (n != null) return dotNum.groupValues[1].trimEnd(' ', '.', '_', '-') to n
        }
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val m = numRe.find(stem)
        if (m != null) {
            val n = m.value.takeIf { it.length <= 18 }?.toLongOrNull()
            if (n != null) {
                val base = stem.substring(0, m.range.first).trimEnd(' ', '.', '_', '-')
                if (base.isNotEmpty()) return base to n
            }
        }
        return stem to null
    }

    /**
     * يتولى ملكية ملف جزء وصل للتو:
     * 1) غرفة تستقبل الآن ← إليها. 2) تجميع بالاسم الأساسي في «غير مصنّف».
     * 3) اسم بلا رقم ← غرفة باسم الـ stem الكامل في «غير مصنّف».
     */
    fun onIncomingPart(path: String, name: String) {
        exec.execute {
            try {
                val src = File(path)
                if (!src.exists()) return@execute
                val target: WatchRoom
                val orderKey: Long
                val receiving = rooms.value.firstOrNull { it.receiving }
                if (receiving != null) {
                    target = receiving
                    orderKey = parseBase(name).second ?: System.currentTimeMillis()
                } else {
                    val (base, num) = parseBase(name)
                    val existing = rooms.value.firstOrNull {
                        it.sectionId == INBOX_ID && it.name.equals(base, ignoreCase = true)
                    }
                    target = existing ?: createRoomInternal(base, INBOX_ID, receiving = false)
                    orderKey = num ?: System.currentTimeMillis()
                }
                val dir = roomDir(target.id)
                var dest = File(dir, sanitize(name))
                if (dest.exists()) {
                    val ext = name.substringAfterLast('.', "")
                    val stem = if (ext.isEmpty()) name else name.dropLast(ext.length + 1)
                    var i = 1
                    while (dest.exists()) {
                        dest = File(dir, if (ext.isEmpty()) sanitize("$stem ($i)") else sanitize("$stem ($i).$ext"))
                        i++
                    }
                }
                val moved = try { src.renameTo(dest) } catch (_: Exception) { false }
                if (!moved) {
                    src.inputStream().use { inp -> dest.outputStream().use { out -> inp.copyTo(out, 256 * 1024) } }
                    src.delete()
                }
                val part = WatchPart(
                    roomId = target.id,
                    fileName = dest.name,
                    name = name,
                    orderKey = orderKey,
                    size = dest.length()
                )
                parts.value = parts.value.toMutableMap().apply {
                    put(target.id, sortParts((get(target.id) ?: emptyList()) + part))
                }
                // غرفة مكتملة عاد إليها جزء جديد: لم تعد مكتملة
                if (target.completedAt != null) {
                    rooms.value = rooms.value.map { if (it.id == target.id) it.copy(completedAt = null) else it }
                }
                changed()
                try { partListener?.invoke(part) } catch (_: Exception) {}
            } catch (_: Exception) {}
        }
    }

    private fun sanitize(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "part" }

    // ───────────────────────── الأقسام ─────────────────────────

    fun allSectionsForDisplay(): List<WatchSection> =
        listOf(WatchSection(FAVORITES_ID, "⭐ المفضلة", builtin = true)) + sections.value

    fun createSection(name: String): WatchSection {
        val s = WatchSection("s" + UUID.randomUUID().toString().take(12), name.trim().ifBlank { "قسم جديد" })
        sections.value = sections.value + s
        changed()
        return s
    }

    fun renameSection(id: String, name: String) {
        if (id == FAVORITES_ID || name.isBlank()) return
        sections.value = sections.value.map { if (it.id == id) it.copy(name = name.trim()) else it }
        changed()
    }

    /** حذف قسم مستخدم: غرفه تنتقل إلى «غير مصنّف» — القسم نفسه لا يُحذف تلقائياً أبداً إلا بطلب صريح */
    fun deleteSection(id: String) {
        val sec = sections.value.firstOrNull { it.id == id } ?: return
        if (sec.builtin || id == INBOX_ID) return
        rooms.value = rooms.value.map { if (it.sectionId == id) it.copy(sectionId = INBOX_ID) else it }
        sections.value = sections.value.filter { it.id != id }
        changed()
    }

    // ───────────────────────── الغرف ─────────────────────────

    private fun createRoomInternal(name: String, sectionId: String, receiving: Boolean): WatchRoom {
        val r = WatchRoom(
            id = "r" + UUID.randomUUID().toString().take(12),
            name = name.trim().ifBlank { "غرفة جديدة" },
            sectionId = if (sectionId == FAVORITES_ID) INBOX_ID else sectionId,
            receiving = receiving
        )
        rooms.value = if (receiving) rooms.value.map { it.copy(receiving = false) } + r else rooms.value + r
        roomDir(r.id)
        return r
    }

    fun createRoom(name: String, sectionId: String, receiving: Boolean = false): WatchRoom {
        val r = createRoomInternal(name, sectionId, receiving)
        changed()
        return r
    }

    fun room(id: String): WatchRoom? = rooms.value.firstOrNull { it.id == id }
    fun roomParts(id: String): List<WatchPart> = parts.value[id] ?: emptyList()
    fun roomSize(id: String): Long = roomParts(id).sumOf { it.size }
    fun sectionRooms(sectionId: String): List<WatchRoom> =
        if (sectionId == FAVORITES_ID) rooms.value.filter { it.favorite }
        else rooms.value.filter { it.sectionId == sectionId }
    fun sectionSize(sectionId: String): Long = sectionRooms(sectionId).sumOf { roomSize(it.id) }

    fun renameRoom(id: String, name: String) {
        if (name.isBlank()) return
        rooms.value = rooms.value.map { if (it.id == id) it.copy(name = name.trim()) else it }
        changed()
    }

    fun setFavorite(id: String, fav: Boolean) {
        rooms.value = rooms.value.map { if (it.id == id) it.copy(favorite = fav) else it }
        changed()
    }

    fun moveRoom(id: String, sectionId: String) {
        if (sectionId == FAVORITES_ID) return
        rooms.value = rooms.value.map { if (it.id == id) it.copy(sectionId = sectionId) else it }
        changed()
    }

    /** غرفة واحدة فقط تستقبل في أي وقت */
    fun setReceiving(id: String?) {
        rooms.value = rooms.value.map { it.copy(receiving = it.id == id) }
        changed()
    }

    fun setCompleted(id: String, completed: Boolean) {
        rooms.value = rooms.value.map {
            if (it.id == id) it.copy(completedAt = if (completed) System.currentTimeMillis() else null) else it
        }
        changed()
    }

    fun updateResume(id: String, partIndex: Int, positionMs: Long) {
        val cur = room(id) ?: return
        if (cur.resumePartIndex == partIndex && kotlin.math.abs(cur.resumePositionMs - positionMs) < 2000) return
        rooms.value = rooms.value.map {
            if (it.id == id) it.copy(resumePartIndex = partIndex, resumePositionMs = positionMs) else it
        }
        persist()
    }

    fun deleteRoom(id: String) {
        rooms.value = rooms.value.filter { it.id != id }
        parts.value = parts.value - id
        exec.execute { try { roomDir(id).deleteRecursively() } catch (_: Exception) {} }
        changed()
    }

    // ───────────────────────── انتهاء مهلة الإكمال (10 ساعات) ─────────────────────────

    /**
     * يحذف كل غرفة مكتملة غير مفضلة مرّت عليها 10 ساعات (ملفات + سجل).
     * التفضيل يُفحص لحظة الحذف: تفضيلها قبل المهلة ينقذها نهائياً من هذا الحذف.
     */
    fun runExpiryCheck() {
        val now = System.currentTimeMillis()
        val doomed = rooms.value.filter {
            it.completedAt != null && !it.favorite && now - (it.completedAt ?: now) >= GRACE_MS
        }
        doomed.forEach { deleteRoom(it.id) }
    }

    fun remainingGraceMs(room: WatchRoom): Long? {
        val c = room.completedAt ?: return null
        if (room.favorite) return null
        return (GRACE_MS - (System.currentTimeMillis() - c)).coerceAtLeast(0)
    }
}
