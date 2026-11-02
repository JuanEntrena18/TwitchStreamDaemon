!macro customInit
  ; Cerrar cualquier proceso en ejecución de StreamDaemon o StreamForger
  ; para no dejar tareas huérfanas bloqueando archivos o puertos.
  DetailPrint "Cerrando procesos activos de StreamDaemon..."
  nsExec::Exec 'taskkill /F /IM StreamDaemon.exe /T'
  nsExec::Exec 'taskkill /F /IM StreamForger.exe /T'
!macroend

!macro customInstall
  ; Asegurar que antes de escribir los nuevos archivos,
  ; no quede ningún subproceso activo residual.
  DetailPrint "Verificando que no haya instancias residuales..."
  nsExec::Exec 'taskkill /F /IM StreamDaemon.exe /T'
  nsExec::Exec 'taskkill /F /IM StreamForger.exe /T'
!macroend

!macro customUnInstall
  ; Al desinstalar, matar procesos residuales primero
  DetailPrint "Deteniendo servicios y procesos de StreamDaemon..."
  nsExec::Exec 'taskkill /F /IM StreamDaemon.exe /T'
  nsExec::Exec 'taskkill /F /IM StreamForger.exe /T'
!macroend

