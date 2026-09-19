import vue from '@vitejs/plugin-vue'

export default defineNuxtConfig({
  extends: '../base',

  compatibilityDate: '2025-01-24',

  hub: {
    db: {
      dialect: 'postgresql',
      // Local/test builds (no DATABASE_URL, e.g. e2e tests via
      // @nuxt/test-utils) use pglite and need this ON -- it's what creates
      // the schema those tests seed against. The Docker build sets
      // DATABASE_URL to a placeholder purely to steer driver selection to
      // postgres-js; nothing is listening on it, so build-time migrations
      // must be OFF there or the build fails with ECONNREFUSED. Migrations
      // against the real database run separately, via the dedicated migrate
      // image (`docker compose run --rm migrate`) at deploy time.
      applyMigrationsDuringBuild: !(
        process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL
      ),
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
