package dev.hinacode.documentview

import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView

internal class BlockHolder(val row: BlockRow) : RecyclerView.ViewHolder(row)

internal class BlockAdapter(private val host: Host) : RecyclerView.Adapter<BlockHolder>() {
  val blocks = ArrayList<Block>()
  private val ids = HashMap<String, Long>()
  var theme = DocumentTheme()

  init {
    setHasStableIds(true)
  }

  override fun getItemCount() = blocks.size

  override fun getItemId(position: Int) = ids.getOrPut(blocks[position].id) { ids.size.toLong() }

  override fun getItemViewType(position: Int) = rowKind(blocks[position].body).ordinal

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
    BlockHolder(BlockRow(parent.context, BlockContent.create(parent.context, RowKind.entries[viewType])))

  override fun onBindViewHolder(holder: BlockHolder, position: Int) =
    holder.row.bind(blocks[position], blocks.getOrNull(position - 1), theme, host)

  fun splice(start: Int, deleteCount: Int, insert: List<Block>) {
    blocks.subList(start, start + deleteCount).clear()
    blocks.addAll(start, insert)
    if (deleteCount > 0) notifyItemRangeRemoved(start, deleteCount)
    if (insert.isNotEmpty()) notifyItemRangeInserted(start, insert.size)
    val following = start + insert.size
    if (following < blocks.size) notifyItemChanged(following)
  }

  fun imageChanged(src: String) {
    blocks.forEachIndexed { index, block -> if ((block.body as? Body.Image)?.src == src) notifyItemChanged(index) }
  }
}
