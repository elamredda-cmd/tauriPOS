!define MARIADB_VERSION "11.4.12"
!define MARIADB_SERVICE_NAME "MariaDB"
!define MARIADB_RESOURCE_PATH "$INSTDIR\mariadb\mariadb-11.4.12-winx64.msi"

!macro EnsureMariaDbService
  nsExec::ExecToLog 'sc config "${MARIADB_SERVICE_NAME}" start= auto'
  nsExec::ExecToLog 'sc start "${MARIADB_SERVICE_NAME}"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfSilent mariadb_skip
  ${If} $PassiveMode = 1
    Goto mariadb_skip
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION "Install MariaDB Server ${MARIADB_VERSION} as well?$\r$\n$\r$\nChoose Yes only if this till will host the shared MariaDB database. MariaDB setup will open, and Windows may ask for administrator permission. The service will be set to start automatically with Windows." IDNO mariadb_skip

  nsExec::ExecToStack 'sc query "${MARIADB_SERVICE_NAME}"'
  Pop $0
  Pop $1
  ${If} $0 = 0
    DetailPrint "MariaDB service already exists. Ensuring it starts automatically."
    !insertmacro EnsureMariaDbService
    Goto mariadb_done
  ${EndIf}

  IfFileExists "${MARIADB_RESOURCE_PATH}" 0 mariadb_missing

  DetailPrint "Starting MariaDB Server ${MARIADB_VERSION} installer..."
  ExecWait '"$SYSDIR\msiexec.exe" /i "${MARIADB_RESOURCE_PATH}" SERVICENAME="${MARIADB_SERVICE_NAME}" PORT=3306 ADDLOCAL=ALL' $0
  ${If} $0 = 0
  ${OrIf} $0 = 3010
    DetailPrint "MariaDB installer finished. Ensuring service starts automatically."
    !insertmacro EnsureMariaDbService
    ${If} $0 = 3010
      MessageBox MB_ICONINFORMATION|MB_OK "MariaDB installed and requested a Windows restart. The POS app is installed."
    ${EndIf}
  ${Else}
    MessageBox MB_ICONEXCLAMATION|MB_OK "The POS app was installed, but MariaDB setup did not finish successfully. MariaDB installer exit code: $0"
  ${EndIf}
  Goto mariadb_done

  mariadb_missing:
    MessageBox MB_ICONEXCLAMATION|MB_OK "The bundled MariaDB installer was not found. The POS app was installed, but MariaDB was not installed."

  mariadb_done:
  mariadb_skip:
!macroend
