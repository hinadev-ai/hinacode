require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ComposerEditor'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = package['license']
  s.author         = 'HinaCode'
  s.homepage       = 'https://github.com/hinadev-ai/hinacode'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
