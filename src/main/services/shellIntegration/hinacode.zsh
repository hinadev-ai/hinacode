autoload -Uz add-zsh-hook
__hinacode_osc() { builtin printf '\e]%s\a' "$1" }
__hinacode_precmd() {
  local code=$?
  __hinacode_osc "133;D;$code"
  __hinacode_osc "7;file://$HOST$PWD"
  __hinacode_osc "133;A"
}
__hinacode_preexec() {
  __hinacode_osc "633;E;${1//[[:cntrl:]]/ }"
  __hinacode_osc "133;C"
}
precmd_functions=(__hinacode_precmd $precmd_functions)
add-zsh-hook preexec __hinacode_preexec
