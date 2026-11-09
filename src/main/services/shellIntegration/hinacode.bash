[[ -f /etc/profile ]] && builtin source /etc/profile
for __hinacode_profile in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [[ -f $__hinacode_profile ]]; then
    builtin source "$__hinacode_profile"
    break
  fi
done
unset __hinacode_profile
__hinacode_osc() { builtin printf '\e]%s\a' "$1"; }
__hinacode_prompt() {
  local code=$?
  __hinacode_osc "133;D;$code"
  __hinacode_osc "7;file://$HOSTNAME$PWD"
  __hinacode_osc "133;A"
  return $code
}
__hinacode_preexec() {
  local line
  line=$(HISTTIMEFORMAT= builtin history 1)
  [[ $line =~ ^[[:space:]]*[0-9]+[*]?[[:space:]]+(.*)$ ]] && line=${BASH_REMATCH[1]}
  __hinacode_osc "633;E;${line//[[:cntrl:]]/ }"
  __hinacode_osc "133;C"
}
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND=(__hinacode_prompt "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__hinacode_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
PS0='$(__hinacode_preexec)'$PS0
