pub mod registry;

pub use registry::{
    delete_user_entry, list_user_entries, save_user_entry, TemplateEntry, TemplateMatch,
    TemplateRegistry, UserTemplateError, UserTemplateRecord, USER_CATEGORY,
};
