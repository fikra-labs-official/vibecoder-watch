// Settings page inside the Zepp app on the phone: the bridge address and key of the owner's own Mac.
// `python3 scripts/configure.py --show-key` on the Mac prints both.
AppSettingsPage({
  build() {
    return Section({}, [
      TextInput({
        label: 'Адрес моста',
        placeholder: 'https://my-mac.tailXXXX.ts.net:8443',
        settingsKey: 'bridgeURL'
      }),
      TextInput({
        label: 'Ключ устройства',
        placeholder: 'из python3 scripts/configure.py --show-key',
        settingsKey: 'deviceToken'
      })
    ])
  }
})
