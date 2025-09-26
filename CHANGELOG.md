# Changelog

## [1.3.0](https://github.com/nestednotation/nestednotation/compare/v1.2.0...v1.3.0) (2025-09-26)


### Features

* add apicache ([b6cef84](https://github.com/nestednotation/nestednotation/commit/b6cef846ed8150555439e7fed044ac789cbd4c17))
* add express monitor (will remove later) ([1b6d4a1](https://github.com/nestednotation/nestednotation/commit/1b6d4a1a5ea0ccb2081e7348228e13eed3093009))
* add request queue back ([282ef5a](https://github.com/nestednotation/nestednotation/commit/282ef5ae2f37158845388d6dde4b39cafb221d48))
* add request queue middleware (max 10 concurrent request, 30s timeout) ([8bb5c94](https://github.com/nestednotation/nestednotation/commit/8bb5c94e49c31ca92eb6e7a41af509bedb08ffe9))
* add session cache to session page, temporary cache session HTML to memory then remove it after 1 minutes if unused ([920d20e](https://github.com/nestednotation/nestednotation/commit/920d20ea3a3d0028fbedc6ea7d8e5f5a686977d1))
* apply simple cache ([6a68b27](https://github.com/nestednotation/nestednotation/commit/6a68b2724f6f367b3410e14f1bd8d6e1c93fd167))
* audio load directly from public server as static file instead of through /audio api ([5e595ab](https://github.com/nestednotation/nestednotation/commit/5e595ab3c79d16b69f2087161d51cc307c39dedd))
* cache promise instead of cached result ([85e4d91](https://github.com/nestednotation/nestednotation/commit/85e4d91a609bbce41f05d6a2420a6be855dfbcf6))
* fix duplicate initial serotonin-v2 ([118ea53](https://github.com/nestednotation/nestednotation/commit/118ea53a487248696d01dcb8fd443cc4ea4664d7))
* ignore old svgContent and htmlContent ([fe3d7cf](https://github.com/nestednotation/nestednotation/commit/fe3d7cfd90a02a67a724ece96f6c6e5f131cab69))
* invalid cache once update the session meta data ([19836a0](https://github.com/nestednotation/nestednotation/commit/19836a0c0dfdac79b61bcdb212b962ec14c3c136))
* move data file nested in public folder to serve audio files directly ([8a878f4](https://github.com/nestednotation/nestednotation/commit/8a878f425dec5463795e8e17fd4290687e52f64f))
* optimize initialize process for session when server start or create new session ([3df5ae3](https://github.com/nestednotation/nestednotation/commit/3df5ae3875831d8ad4efc1607db75869d3e664bd))
* reduce request queue to 5 and increase timeout to 60s ([f9fd38a](https://github.com/nestednotation/nestednotation/commit/f9fd38a3ba0161acc093ce208c658325980513d7))
* remove queue ([441940f](https://github.com/nestednotation/nestednotation/commit/441940fe9e1b5606b3b17bb5459d6e2278f46d3c))
* remove status tracking ([7092675](https://github.com/nestednotation/nestednotation/commit/70926758b99680ffb753b68b2243e2adb92190ed))
* temp remove server_state data ([5d67586](https://github.com/nestednotation/nestednotation/commit/5d67586012d7256eca97d9152b1ea29cfb1f7875))
* undo remove session_state ([2ef40e3](https://github.com/nestednotation/nestednotation/commit/2ef40e3557347c44037d9d1e0e0a7e87c7c22633))


### Bug Fixes

* fallback winning vote to currentIndex in case winningVoteId doesn't exists ([0d53c78](https://github.com/nestednotation/nestednotation/commit/0d53c78fc57fab9b283bc26b4f3a5096f6443152))
* fix bug voting indicator persist ([bc61f30](https://github.com/nestednotation/nestednotation/commit/bc61f305c02076c64cfdd1aae635bc1ee172e6a6))
* fix null vote ([feb04c1](https://github.com/nestednotation/nestednotation/commit/feb04c1d89fb3d41e0334ee516eb4e4346ad1887))
* fix voting indicator persist ([547a0d8](https://github.com/nestednotation/nestednotation/commit/547a0d8d93639124f64ab34684d5c1b2adccb3db))
* fix voting indicator persist ([23c434e](https://github.com/nestednotation/nestednotation/commit/23c434e52632bc8d9534ed5c20f7548eebc8921d))
* fix voting indicator persists ([1407a1b](https://github.com/nestednotation/nestednotation/commit/1407a1b4a37c2c18b5d0c4a7e9befd04ebe34202))
* increase expired time and fix voting container undefined upon load page ([df7dd61](https://github.com/nestednotation/nestednotation/commit/df7dd614ba81146a62c5c6120b5465475fea148f))
* next UAParser in try/catch to prevent typecheck error, voting indicator container hidden ([b3a6bda](https://github.com/nestednotation/nestednotation/commit/b3a6bda3ca934bd55c2c7598171f2ceb02e10c8f))
* null vote ([05b90e2](https://github.com/nestednotation/nestednotation/commit/05b90e290c2f92e69424426b6ddf1a48f43658bb))
* redraw voting on resize window, grayscale maincontent only, autoplay duplicate ([38793aa](https://github.com/nestednotation/nestednotation/commit/38793aafd8af8cc9b4cfb9d77a13b9debdb7bffc))
* stay-btn on visible resize svg ([e2091ea](https://github.com/nestednotation/nestednotation/commit/e2091ea73346ef359d78d34f26e76397e38c17d0))
* voting indicator persist ([786d36a](https://github.com/nestednotation/nestednotation/commit/786d36a59c6b27a4fb94e2cc7e9c7f0164b9fc78))

## [1.2.0](https://github.com/nestednotation/nestednotation/compare/v1.1.0...v1.2.0) (2025-06-04)


### Features

* add animation for winning vote, support voting size ([2773535](https://github.com/nestednotation/nestednotation/commit/2773535b9a0b627cb4590bdb0c98db9277d77f3d))
* implement voting logic partially ([#30](https://github.com/nestednotation/nestednotation/issues/30)) ([76d7ebd](https://github.com/nestednotation/nestednotation/commit/76d7ebd104ae9f14a889a28117aaed55778b4c56))
* remove highlight ring logic ([#32](https://github.com/nestednotation/nestednotation/issues/32)) ([811b2b4](https://github.com/nestednotation/nestednotation/commit/811b2b4d47ee6d21a77ab120a434aae0afc89cd1))


### Bug Fixes

* fix bug voting interval did not clear after done voting ([1403aa0](https://github.com/nestednotation/nestednotation/commit/1403aa02a6810f80781f9342b4cc37a2486542e9))
* fix incorrect wspath ([3057ab6](https://github.com/nestednotation/nestednotation/commit/3057ab6339079a8fe76f57a7d9da218903b17689))
* fix stay btn persist ([346292d](https://github.com/nestednotation/nestednotation/commit/346292db4e91ec742504d1009f3c106cccc3d724))
* fix stay btn persist, fix sound restart when continue between frames, minor change to stay btn css ([338fc6e](https://github.com/nestednotation/nestednotation/commit/338fc6efa6c8e89f505e50f632698e55183fa032))
* fix voting indicator remains after voting stopped ([fe5fbcc](https://github.com/nestednotation/nestednotation/commit/fe5fbcc00ad1aeeee67ca0e212bec3832dba026b))
* fix voting size not working when create session ([797f701](https://github.com/nestednotation/nestednotation/commit/797f7017e617daaab846e9f5e31c9143e33ba909))
* hotfix missing navbar ([e927968](https://github.com/nestednotation/nestednotation/commit/e927968a7f86ec2dd0381d2b450ad4ab399f6655))
* incorrect wsPath ([47ed83f](https://github.com/nestednotation/nestednotation/commit/47ed83f8ce6cff300ad67e88f8636d1cecc4e467))
* qr code render incorrect on android ([3bb927b](https://github.com/nestednotation/nestednotation/commit/3bb927b281fa5dadbfeab5b475361cd7956a45b8))
* track voting based on href element ID instead of vote index, fix font error for vote indicator ([f63debb](https://github.com/nestednotation/nestednotation/commit/f63debbcf067bd02478cb4cdafd4669ad9409cef))
* update new guide mode winning animation to smoother one ([bc744c6](https://github.com/nestednotation/nestednotation/commit/bc744c61c9724b953eb196e5e811abfa1b4a8964))

## [1.1.0](https://github.com/nestednotation/nestednotation/compare/v1.0.0...v1.1.0) (2025-03-20)


### Features

* implement about page for score and nested notation ([#24](https://github.com/nestednotation/nestednotation/issues/24)) ([42f32c0](https://github.com/nestednotation/nestednotation/commit/42f32c05d536ba395ada23a74e1a41e8e6ce36cc))
* implement persist state between deployment ([#21](https://github.com/nestednotation/nestednotation/issues/21)) ([b3054ba](https://github.com/nestednotation/nestednotation/commit/b3054ba92161ce3dec1b658862c7187bfb0150ff))
* update UI according to feedback ([#22](https://github.com/nestednotation/nestednotation/issues/22)) ([3c92ea5](https://github.com/nestednotation/nestednotation/commit/3c92ea536a78e4586b7b27b77a7c6b11d5e4471d))


### Bug Fixes

* add cursor pointer to score title, make score title icon open score document, change return to session btn font size ([#26](https://github.com/nestednotation/nestednotation/issues/26)) ([5d40768](https://github.com/nestednotation/nestednotation/commit/5d407684279ead6f915f053fb141d67cb8abf1f6))
* document view not working on iOS, iPadOS ([#25](https://github.com/nestednotation/nestednotation/issues/25)) ([550eb62](https://github.com/nestednotation/nestednotation/commit/550eb6204bbb8e6f481f9f6718bd9181ef80eaaa))
* fix bug sound didn't load when enable autoplay ([32e375c](https://github.com/nestednotation/nestednotation/commit/32e375cadfcd8ccd064daf8257727fa09ee41b50))
* fix UI feedback, allow go to playmode in guidelock, add unmute audio js ([#23](https://github.com/nestednotation/nestednotation/issues/23)) ([e3f6694](https://github.com/nestednotation/nestednotation/commit/e3f669482431ea767babb4d2c30c52aec18930ca))
* missing scroll bar for session manage UI ([ba558d3](https://github.com/nestednotation/nestednotation/commit/ba558d335650498e7d678b08f61a408df0bac790))

## 1.0.0 (2025-02-04)


### Features

* add fade duration and html5 mode toggle to session config ([#4](https://github.com/nestednotation/nestednotation/issues/4)) ([5f6ad33](https://github.com/nestednotation/nestednotation/commit/5f6ad33ab21af12c9edb41f6e1c6570714fa8953))
* add frame transition and chord mode ([#2](https://github.com/nestednotation/nestednotation/issues/2)) ([3b5a9ba](https://github.com/nestednotation/nestednotation/commit/3b5a9ba4830cb9aa698ab4b4ed5a975d24eb127c))
* Implement NODE mode ([#1](https://github.com/nestednotation/nestednotation/issues/1)) ([0c3ca8c](https://github.com/nestednotation/nestednotation/commit/0c3ca8c3beb0780935b07e27325c5bdb0c037e9b))
* update cta into 3-mode button, sound auto continue based on individual sound, optimize to reduce memory usage ([#3](https://github.com/nestednotation/nestednotation/issues/3)) ([d6f6ad7](https://github.com/nestednotation/nestednotation/commit/d6f6ad7396f5543f5aec451fbe50710dd7ef0668))
* update icon for CTA section ([#5](https://github.com/nestednotation/nestednotation/issues/5)) ([b8f7ce7](https://github.com/nestednotation/nestednotation/commit/b8f7ce72b1a1adaa0e14421e7f416860fae324fa))


### Bug Fixes

* variable not found ([0ed18a3](https://github.com/nestednotation/nestednotation/commit/0ed18a3f4c8747345e3c02fc6e7c6d4aea4f36f4))
