import vue from '@vitejs/plugin-vue'

export default defineNuxtConfig({
  extends: '../base',

  compatibilityDate: '2025-01-24',

  hub: {
    db: {
      dialect: 'postgresql',
      // The Docker build passes NUXT_HUB_DB_DRIVER=postgres-js as a pure
      // marker flag -- it is deliberately NOT a DATABASE_URL/POSTGRES_URL/
      // POSTGRESQL_URL value. @nuxthub/core hard-codes whatever connection
      // string is present at build time into the compiled server output; by
      // selecting the driver here instead of via env-var detection, the real
      // connection vars stay unset during the build, so @nuxthub/core falls
      // back to generating a live `process.env.DATABASE_URL` lookup instead
      // ("lazy env resolution for Docker/multi-deploy scenarios", per its own
      // source) -- required for one built image to work against whatever
      // real DATABASE_URL the VPS's compose.yml sets at container start.
      // Local/test builds (no NUXT_HUB_DB_DRIVER, e.g. e2e tests via
      // @nuxt/test-utils) leave this undefined and fall through to pglite.
      driver: process.env.NUXT_HUB_DB_DRIVER === 'postgres-js' ? 'postgres-js' : undefined,
      // Migrations run separately via the dedicated migrate image
      // (`docker compose run --rm migrate`) at deploy time, against the
      // real database -- never during the build, where there is nothing to
      // connect to. Local/test (pglite) builds still need this ON: it's
      // what creates the schema @nuxt/test-utils' e2e tests seed against.
      applyMigrationsDuringBuild: process.env.NUXT_HUB_DB_DRIVER !== 'postgres-js',
    },
  },

  ssr: false,

  nitro: {
    experimental: {
      openAPI: true
    },
    rollupConfig: {
      // @ts-expect-error - this is not typed
      plugins: [vue()]
    },
    imports: {
      dirs: ['./server/services']
    }
  },

  css: ['~/assets/css/index.css'],

  runtimeConfig: {
    private: {
      resendApiKey: '',
      resendWebhookSecret: '',
      encryptionKey: '',
      adminEmails: '',
      senderEmail: '',
      allowedOrigins: '',
      github: {
        privateKey: '',
      }
    },
    oauth: {
      google: {
        clientId: '',
        clientSecret: '',
      },
      github: {
        clientId: '',
        clientSecret: '',
      },
    }
  },

  $development: {
    runtimeConfig: {
      public: {
        github: {
          appName: 'shelve-local',
        },
      },
    },
  },

  $production: {
    runtimeConfig: {
      public: {
        github: {
          appName: 'shelve-cloud',
        },
      },
    },
  },

  image: {
    format: ['webp', 'jpeg', 'jpg', 'png', 'svg']
  },

  modules: ['@nuxt/ui', 'nuxt-auth-utils', '@nuxthub/core', 'botid/nuxt'],

  $test: {
    modules: ['nuxt-auth-utils', '@nuxthub/core'],
    hub: {
      db: {
        dialect: 'postgresql',
        driver: 'pglite',
      },
    },
  },
})
