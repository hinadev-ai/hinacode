import { type ConfigPlugin, withAppDelegate, withInfoPlist } from "expo/config-plugins"

/**
 * Moves the app onto the UIScene life cycle. The iOS 27.1 SDK, which iPhone Duo needs to run full screen, refuses to
 * launch an app without it, and Expo 57's template still starts React Native from the app delegate. Expo ships the
 * scene delegate; this registers it and leaves window creation to it.
 */
const withSceneLifecycle: ConfigPlugin = (config) => {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "EXExpoAppSceneDelegate" },
        ],
      },
    }
    return config
  })
  return withAppDelegate(config, (config) => {
    config.modResults.contents = replaceOnce(
      replaceOnce(
        config.modResults.contents,
        "class AppDelegate: ExpoAppDelegate {",
        "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {",
      ),
      /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)[\s\S]*?#endif\n/,
      "",
    )
    return config
  })
}

const replaceOnce = (source: string, pattern: string | RegExp, replacement: string) => {
  const next = source.replace(pattern, replacement)
  if (next === source) throw new Error(`with-scene-lifecycle: AppDelegate.swift no longer contains ${pattern}`)
  return next
}

export default withSceneLifecycle
