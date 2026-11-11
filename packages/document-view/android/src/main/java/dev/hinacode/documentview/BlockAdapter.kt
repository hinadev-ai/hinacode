package dev.hinacode.documentview

import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView

internal class BlockHolder(val row: BlockRow) : RecyclerView.ViewHolder(row)

/** The focused block, and the table cell inside it when the block is a table. */
internal data class Focus(val index: Int, val cell: Cell?)

internal class BlockAdapter(private val host: Host) : RecyclerView.Adapter<BlockHolder>() {
  val blocks = ArrayList<Block>()
  private val ids = HashMap<String, Long>()
  private var nextId = 0L
  var theme = DocumentTheme()
  var focus: Focus? = null

  init {
    setHasStableIds(true)
  }

  override fun getItemCount() = blocks.size

  override fun getItemId(position: Int) = ids.getOrPut(blocks[position].id) { nextId++ }

  override fun getItemViewType(position: Int) = rowKind(blocks[position].body, focused = focus?.index == position).ordinal

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
    BlockHolder(BlockRow(parent.context, BlockContent.create(parent.context, RowKind.entries[viewType], host)))

  override fun onBindViewHolder(holder: BlockHolder, position: Int) = holder.row.bind(
    blocks[position],
    blocks.getOrNull(position - 1),
    theme,
    host,
    focus?.takeIf { it.index == position }?.cell,
  )

  /**
   * Replaces [deleteCount] blocks at [start] with [insert]. [keep] is the offset, in both ranges, of a block that stays
   * the same row under a new id: the focused block, whose editor must keep its text, caret and composition.
   */
  fun splice(start: Int, deleteCount: Int, insert: List<Block>, keep: Int? = null) {
    if (keep != null && keep < deleteCount && keep < insert.size) {
      val kept = blocks[start + keep].id
      ids.remove(kept)?.let { ids[insert[keep].id] = it }
    }
    blocks.subList(start, start + deleteCount).clear()
    blocks.addAll(start, insert)
    if (keep == null || keep >= deleteCount || keep >= insert.size) {
      if (deleteCount > 0) notifyItemRangeRemoved(start, deleteCount)
      if (insert.isNotEmpty()) notifyItemRangeInserted(start, insert.size)
    } else {
      val after = start + keep + 1
      if (deleteCount - keep - 1 > 0) notifyItemRangeRemoved(after, deleteCount - keep - 1)
      if (insert.size - keep - 1 > 0) notifyItemRangeInserted(after, insert.size - keep - 1)
      notifyItemChanged(start + keep)
      if (keep > 0) {
        notifyItemRangeRemoved(start, keep)
        notifyItemRangeInserted(start, keep)
      }
    }
    val following = start + insert.size
    if (following < blocks.size) notifyItemChanged(following)
  }

  fun imageChanged(src: String) {
    blocks.forEachIndexed { index, block -> if ((block.body as? Body.Image)?.src == src) notifyItemChanged(index) }
  }
}
