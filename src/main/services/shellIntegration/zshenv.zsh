__hinacode_dir=$ZDOTDIR
if [[ -n ${HINACODE_USER_ZDOTDIR+x} ]]; then
  ZDOTDIR=$HINACODE_USER_ZDOTDIR
  unset HINACODE_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
[[ -f ${ZDOTDIR:-$HOME}/.zshenv ]] && builtin source ${ZDOTDIR:-$HOME}/.zshenv
[[ -o interactive ]] && builtin source $__hinacode_dir/hinacode.zsh
unset __hinacode_dir
