function __hinacode_osc
  printf '\e]%s\a' $argv[1]
end
function __hinacode_prompt --on-event fish_prompt
  __hinacode_osc "7;file://$hostname$PWD"
  __hinacode_osc "133;A"
end
function __hinacode_preexec --on-event fish_preexec
  __hinacode_osc "633;E;"(string join ' ' -- (string replace -ra '[[:cntrl:]]' ' ' -- $argv[1]))
  __hinacode_osc "133;C"
end
function __hinacode_postexec --on-event fish_postexec
  __hinacode_osc "133;D;$status"
end
