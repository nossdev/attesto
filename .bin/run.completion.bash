# Bash completion for the `run` shim (mise-task tab-completion).
#
# Usage: source from your shell rc once per session, or symlink into a
# completion-loading dir:
#   source /path/to/attesto/.bin/run.completion.bash
#
# Zsh users: enable bashcompinit first, then source this file.
#   autoload -U bashcompinit && bashcompinit
#   source /path/to/attesto/.bin/run.completion.bash

_run_complete() {
  local cur="${COMP_WORDS[COMP_CWORD]}"

  # Only complete the first positional (the task name). After that the user
  # is providing args/flags to the task itself; let mise/usage handle them.
  if [ "$COMP_CWORD" -eq 1 ]; then
    local tasks
    tasks=$(mise tasks --no-header 2>/dev/null | awk '{print $1}')
    COMPREPLY=($(compgen -W "$tasks" -- "$cur"))
  fi
}

complete -F _run_complete run
