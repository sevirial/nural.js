import { Command } from "commander";

export function completionCommand(program: Command) {
  return () => {
    const commands = program.commands.map((cmd) => cmd.name()).join(" ");

    const script = `
###-begin-nural-completion-###
#
# nural command completion script
#
# Installation: nural completion >> ~/.zshrc  (or ~/.bashrc)
# Source it: source <(nural completion)
#

_nural_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    opts="${commands}"

    case "\${prev}" in
        generate|g)
            opts="resource middleware provider filter"
            ;;
        add)
            opts="redis rabbitmq mongoose prisma-pg"
            ;;
        *)
            ;;
    esac

    COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
    return 0
}
complete -F _nural_completion nural

###-end-nural-completion-###
`;
    console.log(script.trim());
  };
}
