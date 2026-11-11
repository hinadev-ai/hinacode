import ExpoModulesCore
import QuartzCore

public class PerfFramesModule: Module {
  private var sampler: FrameSampler?

  public func definition() -> ModuleDefinition {
    Name("PerfFrames")

    AsyncFunction("start") {
      self.sampler?.stop()
      self.sampler = FrameSampler()
    }.runOnQueue(.main)

    AsyncFunction("stop") { () -> [Double] in
      let timestamps = self.sampler?.stop() ?? []
      self.sampler = nil
      return timestamps
    }.runOnQueue(.main)
  }
}

final class FrameSampler: NSObject {
  private var link: CADisplayLink?
  private var timestamps: [Double] = []

  override init() {
    super.init()
    let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  @objc private func tick(_ link: CADisplayLink) {
    timestamps.append(link.timestamp * 1000)
  }

  func stop() -> [Double] {
    link?.invalidate()
    link = nil
    return timestamps
  }
}
