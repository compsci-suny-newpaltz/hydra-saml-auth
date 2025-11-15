# ~/.bashrc for student user in hydra-student-container
# Loaded for interactive shells. Provides quality-of-life aliases and prompt.

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

# History settings
HISTSIZE=5000
HISTFILESIZE=10000
shopt -s histappend
PROMPT_COMMAND='history -a; history -n;'

# Color support
if [ -x /usr/bin/dircolors ]; then
    eval "$(dircolors -b)"
fi

# Aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias gs='git status'
alias gp='git pull'
alias gd='git diff'
alias venv='python -m venv .venv && echo "Run: source .venv/bin/activate"'

# Make sure python refers to python3 in interactive shells (redundant with package but explicit)
alias python='python3'

# NVM initialization if present
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
fi
if [ -s "$NVM_DIR/bash_completion" ]; then
    . "$NVM_DIR/bash_completion"
fi

# Enhanced prompt
# Format: user@host:cwd (git_branch) [time]
parse_git_branch() {
    git rev-parse --is-inside-work-tree &>/dev/null || return
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
    [ -n "$branch" ] && echo "($branch)"
}

# Colors
BLUE='\[\e[34m\]'
GREEN='\[\e[32m\]'
YELLOW='\[\e[33m\]'
MAGENTA='\[\e[35m\]'
CYAN='\[\e[36m\]'
RED='\[\e[31m\]'
RESET='\[\e[0m\]'

# Time and path
PS_TIME='\t'
PS_PATH='\w'
PS_GIT='$(parse_git_branch)'

# Final PS1
export PS1="${GREEN}\u${RESET}@${BLUE}\h${RESET}:${CYAN}${PS_PATH}${MAGENTA} ${PS_GIT} ${YELLOW}[${PS_TIME}]${RESET}\n$ "

# Python user bin path (already set in Dockerfile, ensure present)
PATH="$HOME/.local/bin:$PATH"
export PATH

# Enable virtualenv auto-activation if .venv exists
if [ -d .venv ]; then
    if [ -f .venv/bin/activate ]; then
        . .venv/bin/activate
    fi
fi

# Completion tweaks
if [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
fi

# Docker convenience
alias d='docker'
alias dc='docker compose'

# Confirm loaded
# echo "Loaded student .bashrc"
