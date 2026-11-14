package dev.hinacode.perfframes

import android.view.Choreographer
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PerfFramesModule : Module() {
  private var sampler: FrameSampler? = null

  override fun definition() = ModuleDefinition {
    Name("PerfFrames")

    AsyncFunction("start") {
      sampler?.stop()
      sampler = FrameSampler().also { it.start() }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      val timestamps = sampler?.stop() ?: emptyList()
      sampler = null
      timestamps
    }.runOnQueue(Queues.MAIN)
  }
}

class FrameSampler : Choreographer.FrameCallback {
  private val timestamps = mutableListOf<Double>()
  private var running = false

  fun start() {
    running = true
    Choreographer.getInstance().postFrameCallback(this)
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (!running) return
    timestamps.add(frameTimeNanos / 1_000_000.0)
    Choreographer.getInstance().postFrameCallback(this)
  }

  fun stop(): List<Double> {
    running = false
    Choreographer.getInstance().removeFrameCallback(this)
    return timestamps.toList()
  }
}
